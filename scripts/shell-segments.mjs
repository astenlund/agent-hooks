// Shared shell parsing for the plugin's PreToolUse hooks: splits a Bash or
// PowerShell tool command into pipeline segments and shell words in the
// tool's dialect (bash escapes with a backslash and substitutes in
// backticks; PowerShell escapes with a backtick, a backslash is a path
// separator, and a { scriptblock } nests commands), and finds each
// segment's command word behind keywords, assignments and wrappers.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'case', 'esac', '{', '}', '!']);
// Every long option of each listed wrapper (GNU coreutils 8.32, findutils 4.10), so an abbreviation resolves as getopt resolves it.
const LONG_OPTIONS = {
  env: ['ignore-environment', 'null', 'unset', 'chdir', 'split-string', 'block-signal', 'default-signal', 'ignore-signal', 'list-signal-handling', 'debug', 'help', 'version'],
  nice: ['adjustment', 'help', 'version'],
  stdbuf: ['input', 'output', 'error', 'help', 'version'],
  timeout: ['foreground', 'kill-after', 'preserve-status', 'signal', 'verbose', 'help', 'version'],
  xargs: ['null', 'arg-file', 'delimiter', 'eof', 'replace', 'max-lines', 'max-args', 'open-tty', 'max-procs', 'interactive', 'process-slot-var', 'no-run-if-empty', 'max-chars', 'show-limits', 'verbose', 'exit', 'help', 'version'],
};
// Wrappers that run another command: their value-taking options and leading positionals are skipped.
// A wrapper that lists its long options also has an unambiguous abbreviation of each recognised;
// one marked dash also takes a bare - as an option (env - is env -i), and one that lists splits has options
// whose value is itself the start of the command line (env -S 'sed -i' f runs sed -i f).
const WRAPPERS = {
  env: { values: ['-u', '-C', '--unset', '--chdir'], longs: LONG_OPTIONS.env, dash: true, splits: ['-S', '--split-string'] }, command: {}, builtin: {}, exec: {}, time: {}, nohup: {}, chronic: {},
  sudo: { values: ['-u', '-g', '-C', '-p', '-r', '-t', '-U', '-h', '-D'] }, nice: { values: ['-n', '--adjustment'], longs: LONG_OPTIONS.nice },
  ionice: { values: ['-c', '-n', '-p'] }, timeout: { values: ['-s', '-k', '--signal', '--kill-after'], positionals: 1, longs: LONG_OPTIONS.timeout },
  xargs: { values: ['-n', '-P', '-I', '-L', '-d', '-s', '-E', '-a', '--max-args', '--max-procs', '--delimiter', '--max-chars', '--arg-file', '--process-slot-var'], longs: LONG_OPTIONS.xargs }, stdbuf: { values: ['-i', '-o', '-e', '--input', '--output', '--error'], longs: LONG_OPTIONS.stdbuf },
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

// Split into segments at unquoted |, |&, ||, &&, &, ;, newline, (, ), $(,
// PowerShell's @( and backticks; split each segment into words, stripping
// quotes. Heredoc bodies
// are skipped so their content is never mistaken for commands; a herestring
// operand is dropped and marks the segment as fed from stdin. Each segment
// records its scope (the frame of the substitution, group or block enclosing
// it, or null at the top level); a substitution's segments are returned ahead
// of the segment it sits in. Each frame records its parent frame and its
// owner: the segment whose words opened it, which is every substitution's and
// block's, and a group's written after a word, or null for a group standing
// as a command.
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
  // state is restored. In PowerShell a group written after a word is an
  // argument expression (Set-Location (Join-Path a b) -PassThru), so it
  // nests like a substitution and the words after it stay in the segment.
  const frames = [];
  const newSegment = pipedIn => ({ words: [], pipedIn, stdinFed: false, scope: frames.at(-1) ?? null });
  let segment = newSegment(false);
  let word = '';
  let inWord = false;
  let quote = null;
  let dropWord = false;
  const pendingDelimiters = [];
  const flush = () => { if (inWord && !dropWord) segment.words.push(word); if (inWord) dropWord = false; word = ''; inWord = false; };
  const cut = pipedIn => { flush(); result.push(segment); segment = newSegment(pipedIn); dropWord = false; };
  // Whether the segment holds word text, so a frame opened now sits inside it.
  const started = () => word !== '' || segment.words.length > 0;
  const open = (closer, arithmetic, splice, start) => {
    const owner = splice || started() ? segment : null;
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
    // A PowerShell here-string, @' or @" starting a word (or right after an assignment's =, as in $text=@', $text =@', [string]$text=@' or [string[]]$text=@')
    // and ending its line, closed by '@ or "@ starting a line, is one word of text, so a quote or command inside it is
    // data; subexpressions in an @" one are not inspected. The word test runs only at an @, keeping the scan linear.
    if (blocks && char === '@' && (command[index + 1] === "'" || command[index + 1] === '"') && ((word === '' && !inWord) || /^(?:(?:\[(?:[^[\]]|\[[^\]]*\])*\])*\$[\w:]+)?=$/.test(word)) && /^[ \t]*\r?\n/.test(command.slice(index + 2))) {
      const close = command.indexOf(`\n${command[index + 1]}@`, index + 2);
      word += command.slice(index + 2, close < 0 ? command.length : close);
      inWord = true;
      index = close < 0 ? command.length : close + 2;
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
    if ((char === '$' || (blocks && char === '@')) && command[index + 1] === '(') { // @( is PowerShell's array subexpression
      const arithmetic = char === '$' && command[index + 2] === '(';
      open(')', arithmetic, true);
      index += arithmetic ? 2 : 1;
      continue;
    }
    if (char === '(') {
      const argument = blocks && started();
      if (argument) flush(); // the group ends the word before it, so cd($x) keeps cd as its command word
      open(')', false, argument);
      continue;
    }
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

// The full spelling of a detached --name option among a wrapper's long options: the name itself, or the one
// option it is an unambiguous prefix of. Any other word, including an ambiguous prefix, is returned unchanged.
function fullLongOption(word, longs) {
  if (!longs || !word.startsWith('--') || word.includes('=')) return word;
  const name = word.slice(2);
  const matches = longs.filter(option => option.startsWith(name));

  return longs.includes(name) || matches.length !== 1 ? word : `--${matches[0]}`;
}

// The words a split option (env -S, --split-string, attached or detached) leaves in place of itself and its
// value: the value split at spaces, ahead of the words after it, which env runs as one command line. Null when
// the first word is not such an option.
function splitWords(rest, wrapper) {
  if (!wrapper.splits) return null;
  const [word, next] = rest;
  const isLong = word.startsWith('--');
  const name = isLong ? fullLongOption(word.split('=')[0], wrapper.longs) : word.slice(0, 2);
  if (!wrapper.splits.includes(name)) return null;
  const equals = word.indexOf('=');
  const attached = isLong ? (equals < 0 ? null : word.slice(equals + 1)) : (word.length > 2 ? word.slice(2) : null);
  const value = attached ?? next ?? '';

  return [...value.split(' ').filter(Boolean), ...rest.slice(attached === null ? 2 : 1)];
}

// Drop shell keywords, assignments and wrapper commands ahead of the real command word.
export function commandWords(words) {
  let rest = words;
  for (;;) {
    if (rest.length === 0) return rest;
    if (KEYWORDS.has(rest[0]) || isAssignment(rest[0])) { rest = rest.slice(1); continue; }
    const wrapper = WRAPPERS[baseName(rest[0])];
    if (!wrapper) return rest;
    // command -v and -V, alone or among its other options (-p), only report what a name resolves to; the name is not run.
    if (baseName(rest[0]) === 'command') {
      const end = rest.findIndex((word, at) => at > 0 && !/^-[A-Za-z]+$/.test(word));
      if (rest.slice(1, end < 0 ? rest.length : end).some(option => /[vV]/.test(option))) return [];
    }
    rest = rest.slice(1);
    let positionals = wrapper.positionals ?? 0;
    while (rest.length > 0) {
      if (isAssignment(rest[0]) || (wrapper.dash && rest[0] === '-')) { rest = rest.slice(1); continue; }
      const split = splitWords(rest, wrapper);
      if (split) { rest = split; continue; }
      if (isOption(rest[0])) { rest = rest.slice((wrapper.values ?? []).includes(fullLongOption(rest[0], wrapper.longs)) ? 2 : 1); continue; }
      if (positionals > 0) { positionals--; rest = rest.slice(1); continue; }
      break;
    }
  }
}
