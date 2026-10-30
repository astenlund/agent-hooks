// Shared shell parsing for the plugin's PreToolUse hooks: splits a Bash or
// PowerShell tool command into pipeline segments and shell words in the
// tool's dialect (bash escapes with a backslash and substitutes in
// backticks; PowerShell escapes with a backtick, a backslash is a path
// separator, and a { scriptblock } nests commands), and finds each
// segment's command word behind keywords, assignments and wrappers.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'case', 'esac', '{', '}', '!']);
// Wrappers that run another command: their value-taking options and leading positionals are skipped.
const WRAPPERS = {
  env: { values: ['-u', '-C', '-S', '--unset', '--chdir'] }, command: {}, exec: {}, time: {}, nohup: {}, chronic: {},
  sudo: { values: ['-u', '-g', '-C', '-p', '-r', '-t', '-U', '-h', '-D'] }, nice: { values: ['-n', '--adjustment'] },
  ionice: { values: ['-c', '-n', '-p'] }, timeout: { values: ['-s', '-k', '--signal', '--kill-after'], positionals: 1 },
  xargs: { values: ['-n', '-P', '-I', '-L', '-d', '-s', '-E', '-a'] }, stdbuf: { values: ['-i', '-o', '-e'] },
  function: { positionals: 1 },
};

const DQ_ESCAPABLE = new Set(['$', '`', '"', '\\', '\n']);
// PowerShell escapes that matter for statement counting resolve to their control character.
const PWSH_ESCAPES = { n: String.fromCharCode(10), r: String.fromCharCode(13) };
// How each tool's shell reads its command text: the escape character, whether backticks
// substitute, and whether braces open a scriptblock whose contents are commands too.
export const DIALECTS = {
  Bash: { escape: '\\', substitutes: true, blocks: false, unescape: next => next },
  PowerShell: { escape: '`', substitutes: false, blocks: true, unescape: next => PWSH_ESCAPES[next] ?? next },
};

// Split into segments at unquoted |, |&, ||, &&, &, ;, newline, (, ), $( and
// backticks; split each segment into words, stripping quotes. Heredoc bodies
// are skipped so their content is never mistaken for commands; a herestring
// operand is dropped and marks the segment as fed from stdin. Each segment
// records its scope (the frame of the substitution, group or block enclosing
// it, or null at the top level), its order of appearance in the source, since
// a substitution's segments are returned ahead of the segment it sits in, and
// whether it opens with a frame rather than a word. Each frame records its
// parent frame and its owner: the segment whose words opened it, which is
// every substitution's and block's, and a group's written as an argument
// (Set-Location (Join-Path a b)), or null for a group standing as a command.
export function segments(command, dialect) {
  const { escape, substitutes, blocks, unescape } = dialect;
  const result = [];
  // A word-level substitution ($(...), $((...)), backticks) suspends the
  // enclosing segment and word; closing it restores them with a placeholder
  // standing in for the substituted text, so $(pwd)/x.js still counts as a
  // script argument. A PowerShell scriptblock ({ ... }) nests the same way,
  // but restores the block's source text instead, so a block passed as a
  // -Command body can still be counted. A bare ( ... ) group is a command
  // delimiter instead: it cuts the enclosing segment and only the quote
  // state is restored.
  const frames = [];
  let created = 0;
  const newSegment = pipedIn => ({ words: [], pipedIn, stdinFed: false, scope: frames.at(-1) ?? null, order: created++, opensWithFrame: false });
  let segment = newSegment(false);
  let word = '';
  let inWord = false;
  let quote = null;
  let dropWord = false;
  const pendingDelimiters = [];
  const flush = () => { if (inWord && !dropWord) segment.words.push(word); if (inWord) dropWord = false; word = ''; inWord = false; };
  const cut = pipedIn => { flush(); result.push(segment); segment = newSegment(pipedIn); dropWord = false; };
  const open = (closer, arithmetic, splice, start) => {
    const started = segment.words.length > 0 || inWord;
    const owner = splice || started ? segment : null;
    if (splice && !started) segment.opensWithFrame = true;
    if (!splice) cut(false);
    frames.push({ quote, closer, arithmetic, start, parent: frames.at(-1) ?? null, owner, outer: splice ? { segment, word, inWord, dropWord } : null });
    quote = null; segment = newSegment(false); word = ''; inWord = false; dropWord = false;
  };
  const close = end => {
    cut(false);
    const frame = frames.pop();
    quote = frame.quote;
    segment.scope = frames.at(-1) ?? null; // the segment cut opened continues after the frame
    if (!frame.outer) return;
    ({ segment, word, inWord, dropWord } = frame.outer);
    word += frame.start === undefined ? 'SUBSTITUTION' : command.slice(frame.start, end + 1); inWord = true;
  };
  const inArithmetic = () => frames.length > 0 && frames[frames.length - 1].arithmetic;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === escape && quote === '"' && command[index + 1] === '\n') index++; // line continuation
      else if (char === escape && quote === '"' && (!substitutes || DQ_ESCAPABLE.has(command[index + 1]))) word += unescape(command[++index]);
      else if (quote === '"' && char === '$' && command[index + 1] === '(') { open(')', command[index + 2] === '(', true); index += command[index + 2] === '(' ? 2 : 1; }
      else if (substitutes && quote === '"' && char === '`') open('`', false, true);
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; inWord = true; continue; }
    if (char === escape) {
      if (command[index + 1] === '\n') { index++; continue; }
      if (index + 1 < command.length) { word += unescape(command[++index]); inWord = true; }
      continue;
    }
    if (char === '\n') {
      cut(false);
      while (pendingDelimiters.length > 0 && index < command.length) {
        const end = command.indexOf('\n', index + 1);
        const line = command.slice(index + 1, end < 0 ? command.length : end).replace(/^\t+/, '').trimEnd();
        if (line === pendingDelimiters[0]) pendingDelimiters.shift();
        index = end < 0 ? command.length : end;
      }
      continue;
    }
    if (char === '<' && command[index + 1] === '<' && !inArithmetic()) {
      flush();
      segment.stdinFed = true;
      if (command[index + 2] === '<') { dropWord = true; index += 2; continue; } // herestring: drop its operand
      const match = /^<<-?\s*(?:'([^']*)'|"([^"]*)"|([^\s|&;<>]+))/.exec(command.slice(index));
      if (match) { pendingDelimiters.push(match[1] ?? match[2] ?? match[3]); index += match[0].length - 1; }
      else index++;
      continue;
    }
    if (char === '&' && (/[<>]$/.test(word) || command[index + 1] === '>')) { word += char; inWord = true; continue; }
    if (char === '|') {
      const next = command[index + 1];
      cut(next !== '|');
      if (next === '|' || next === '&') index++;
      continue;
    }
    if (char === '&') { cut(false); if (command[index + 1] === '&') index++; continue; }
    if (char === '$' && command[index + 1] === '(') { open(')', command[index + 2] === '(', true); index += command[index + 2] === '(' ? 2 : 1; continue; }
    if (char === '(') { open(')', false, false); continue; }
    if (substitutes && char === '`') { if (frames.length > 0 && frames[frames.length - 1].closer === '`') close(index); else open('`', false, true); continue; }
    if (char === ')') {
      if (frames.length > 0 && frames[frames.length - 1].closer === ')') { if (inArithmetic() && command[index + 1] === ')') index++; close(index); }
      else cut(false);
      continue;
    }
    if (blocks && char === '{') { open('}', false, true, index); continue; }
    if (blocks && char === '}') {
      if (frames.length > 0 && frames[frames.length - 1].closer === '}') close(index);
      else cut(false);
      continue;
    }
    if (char === ';') { cut(false); continue; }
    if (/\s/.test(char)) { flush(); continue; }
    word += char;
    inWord = true;
  }
  while (frames.length > 0) close(command.length - 1); // an unclosed substitution or block still yields its enclosing segment
  cut(false);
  return result.filter(item => item.words.length > 0);
}

export const isAssignment = word => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
export const isRedirection = word => /^(?:\d*[<>]{1,2}&?\d*|&>>?|\d*[<>]{1,2}&?\S+|&>>?\S+)$/.test(word);
export const isOption = word => word.startsWith('-') && word !== '-';
export const baseName = word => word.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');

// Drop shell keywords, assignments and wrapper commands ahead of the real command word.
export function commandWords(words) {
  let rest = words;
  for (;;) {
    if (rest.length === 0) return rest;
    if (KEYWORDS.has(rest[0]) || isAssignment(rest[0])) { rest = rest.slice(1); continue; }
    const wrapper = WRAPPERS[baseName(rest[0])];
    if (!wrapper) return rest;
    rest = rest.slice(1);
    let positionals = wrapper.positionals ?? 0;
    while (rest.length > 0) {
      if (isAssignment(rest[0])) { rest = rest.slice(1); continue; }
      if (isOption(rest[0])) { rest = rest.slice((wrapper.values ?? []).includes(rest[0]) ? 2 : 1); continue; }
      if (positionals > 0) { positionals--; rest = rest.slice(1); continue; }
      break;
    }
  }
}
