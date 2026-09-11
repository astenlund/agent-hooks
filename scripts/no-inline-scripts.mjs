// PreToolUse hook (matcher: Bash): refuse inline interpreter bodies so
// script text never passes through shell quoting layers. The command is
// split into pipeline segments and shell words, then each segment's
// command word is classified:
//   node, nodejs, bun: -e, -p, -pe, -ep, --eval, --print (also --eval=...),
//     or reading a program from stdin (piped in, heredoc, herestring, "-")
//   deno: the eval subcommand, or a program from stdin
//   python, python3, python3.x, py: a short-option cluster carrying c
//     (-c, -Bc, -c'body'), or a program from stdin; -m module runs pass
//   bash, sh, zsh, pwsh, powershell: a program from stdin only
// A segment with a script argument passes, including a plain-data heredoc
// or pipe feeding that script. Exits 2 with the reason on stderr to block;
// exits 0 on no match or malformed input (fail-open). Registered by the
// plugin's hooks/hooks.json; self-test: node scripts/no-inline-scripts.test.mjs
import { readFileSync } from 'node:fs';

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'case', 'esac', '{', '}', '!']);
// Wrappers that run another command: their value-taking options and leading positionals are skipped.
const WRAPPERS = {
  env: { values: ['-u', '-C', '-S', '--unset', '--chdir'] }, command: {}, exec: {}, time: {}, nohup: {}, chronic: {},
  sudo: { values: ['-u', '-g', '-C', '-p', '-r', '-t', '-U', '-h', '-D'] }, nice: { values: ['-n', '--adjustment'] },
  ionice: { values: ['-c', '-n', '-p'] }, timeout: { values: ['-s', '-k', '--signal', '--kill-after'], positionals: 1 },
  xargs: { values: ['-n', '-P', '-I', '-L', '-d', '-s', '-E', '-a'] }, stdbuf: { values: ['-i', '-o', '-e'] },
  function: { positionals: 1 },
};
const NODE_VALUE_OPTIONS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--env-file', '-C', '--conditions']);
const PYTHON_VALUE_OPTIONS = new Set(['-W', '-X', '-Q']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'pwsh', 'powershell']);
const DQ_ESCAPABLE = new Set(['$', '`', '"', '\\', '\n']);

// Split into segments at unquoted |, |&, ||, &&, &, ;, newline, (, ), $( and
// backticks; split each segment into words, stripping quotes. Heredoc bodies
// are skipped so their content is never mistaken for commands; a herestring
// operand is dropped and marks the segment as fed from stdin.
function segments(command) {
  const result = [];
  let segment = { words: [], pipedIn: false, stdinFed: false };
  let word = '';
  let inWord = false;
  let quote = null;
  let dropWord = false;
  const pendingDelimiters = [];
  // A word-level substitution ($(...), $((...)), backticks) suspends the
  // enclosing segment and word; closing it restores them with a placeholder
  // standing in for the substituted text, so $(pwd)/x.js still counts as a
  // script argument. A bare ( ... ) group is a command delimiter instead: it
  // cuts the enclosing segment and only the quote state is restored.
  const frames = [];
  const flush = () => { if (inWord && !dropWord) segment.words.push(word); if (inWord) dropWord = false; word = ''; inWord = false; };
  const cut = pipedIn => { flush(); result.push(segment); segment = { words: [], pipedIn, stdinFed: false }; dropWord = false; };
  const open = (closer, arithmetic, splice) => {
    if (!splice) cut(false);
    frames.push({ quote, closer, arithmetic, outer: splice ? { segment, word, inWord, dropWord } : null });
    quote = null; segment = { words: [], pipedIn: false, stdinFed: false }; word = ''; inWord = false; dropWord = false;
  };
  const close = () => {
    cut(false);
    const frame = frames.pop();
    quote = frame.quote;
    if (!frame.outer) return;
    ({ segment, word, inWord, dropWord } = frame.outer);
    word += 'SUBSTITUTION'; inWord = true;
  };
  const inArithmetic = () => frames.length > 0 && frames[frames.length - 1].arithmetic;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && DQ_ESCAPABLE.has(command[index + 1])) word += command[++index];
      else if (quote === '"' && char === '$' && command[index + 1] === '(') { open(')', command[index + 2] === '(', true); index += command[index + 2] === '(' ? 2 : 1; }
      else if (quote === '"' && char === '`') open('`', false, true);
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; inWord = true; continue; }
    if (char === '\\') {
      if (command[index + 1] === '\n') { index++; continue; }
      if (index + 1 < command.length) { word += command[++index]; inWord = true; }
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
    if (char === '`') { if (frames.length > 0 && frames[frames.length - 1].closer === '`') close(); else open('`', false, true); continue; }
    if (char === ')') {
      if (frames.length > 0 && frames[frames.length - 1].closer === ')') { if (inArithmetic() && command[index + 1] === ')') index++; close(); }
      else cut(false);
      continue;
    }
    if (char === ';') { cut(false); continue; }
    if (/\s/.test(char)) { flush(); continue; }
    word += char;
    inWord = true;
  }
  while (frames.length > 0) close(); // an unclosed substitution still yields its enclosing segment
  cut(false);
  return result.filter(item => item.words.length > 0);
}

const isAssignment = word => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
const isRedirection = word => /^(?:\d*[<>]{1,2}&?\d*|&>>?|\d*[<>]{1,2}&?\S+|&>>?\S+)$/.test(word);
const isOption = word => word.startsWith('-') && word !== '-';
const baseName = word => word.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');

// Drop shell keywords, assignments and wrapper commands ahead of the real command word.
function commandWords(words) {
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

function classify(segment) {
  const words = commandWords(segment.words);
  if (words.length === 0) return null;
  const name = baseName(words[0]);
  const args = words.slice(1);
  const family = /^(?:node|nodejs|bun)$/.test(name) ? 'node' : name === 'deno' ? 'deno' : /^(?:python(?:3(?:\.\d+)?)?|py)$/.test(name) ? 'python' : SHELLS.has(name) ? 'shell' : null;
  if (!family) return null;
  let expectValue = false;
  let subcommand = null;
  for (const arg of args) {
    if (expectValue) { expectValue = false; continue; }
    if (isRedirection(arg)) continue;
    if (arg === '-') return `${name} reading a program from stdin`;
    if (!isOption(arg)) {
      if (family !== 'deno' || subcommand) return null; // a script or module argument: nothing inline
      subcommand = arg;
      if (subcommand === 'eval') return 'deno eval inline body';
      continue;
    }
    if (arg === '--') return null;
    if (family === 'deno') {
      if (/^--eval(?:=|$)/.test(arg)) return 'deno inline body (--eval)';
      continue;
    }
    if (family === 'node') {
      if (/^-(?:e|p|pe|ep)$/.test(arg) || /^--(?:eval|print)(?:=|$)/.test(arg)) return `${name} inline body (${arg})`;
      if (NODE_VALUE_OPTIONS.has(arg)) expectValue = true;
    } else if (family === 'python') {
      if (arg.startsWith('-m')) return null; // module run; anything after belongs to the module
      const cluster = /^-([A-Za-z]*)c/.exec(arg); // -c, -Bc, -c'body', -cbody; but -Wc is a warning filter
      if (cluster && !/[WXQ]/.test(cluster[1])) return `${name} inline body (${arg.slice(0, 12)})`;
      if (PYTHON_VALUE_OPTIONS.has(arg)) expectValue = true;
    }
  }
  const fed = segment.pipedIn || segment.stdinFed;
  if (family === 'deno') return fed && subcommand === 'run' ? 'deno reading a program from stdin' : null;
  return fed ? `${name} reading a program from stdin` : null;
}

function inspect(command) {
  if (typeof command !== 'string') return null;
  for (const segment of segments(command)) {
    const rule = classify(segment);
    if (rule) return { rule, snippet: segment.words.join(' ').slice(0, 120) };
  }
  return null;
}

let input;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); } // fail-open on an unexpected envelope
if (input?.tool_name !== 'Bash') process.exit(0);
const found = inspect(input.tool_input?.command);
if (!found) process.exit(0);
process.stderr.write(`Blocked by no-inline-scripts hook (${found.rule}): ${found.snippet}\nWrite the script body to a .tmp/ or scratchpad file with the Write tool and run it by path. Use jq for a single JSON field pick. Heredocs and pipes may carry plain data into a script run by path, never the script itself, and no inline fallback may be chained after a script file.\n`);
process.exit(2);
