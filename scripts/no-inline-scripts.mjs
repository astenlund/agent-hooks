// PreToolUse hook (matcher: Bash|PowerShell): refuse inline interpreter
// bodies so script text never passes through shell quoting layers. The
// command is split into pipeline segments and shell words in the tool's
// dialect (bash escapes with a backslash and substitutes in backticks;
// PowerShell escapes with a backtick, a backslash is a path separator, and
// a { scriptblock } nests commands), then each segment's command word is
// classified:
//   node, nodejs, bun: -e, -p, -pe, -ep, --eval, --print (also --eval=...),
//     or reading a program from stdin (piped in, heredoc, herestring, "-")
//   deno: the eval subcommand, or a program from stdin
//   python, python3, python3.x, py: a short-option cluster carrying c
//     (-c, -Bc, -c'body'), or a program from stdin; -m module runs pass
//   bash, sh, zsh: a -c body of more than one statement or over 200
//     characters, or a program from stdin
//   pwsh, powershell: a -Command or -CommandWithArgs (-c, -cwa, any
//     unambiguous prefix) body of more than one statement or over 200
//     characters, an -EncodedCommand body, or a program from stdin
// Statements in a body are counted as its interpreter reads them: unquoted
// semicolons and newlines separate them, a single & too in a bash body. A
// one-statement -c or -Command body passes because the rule this hook
// enforces allows a one-liner there. A segment with a script argument
// passes, including a plain-data heredoc or pipe feeding that script.
// Exits 2 with the reason on stderr to block; exits 0 on no match or
// malformed input (fail-open). Registered by the plugin's hooks/hooks.json;
// self-test: node scripts/no-inline-scripts.test.mjs
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
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh']);
const POWERSHELLS = new Set(['pwsh', 'powershell']);
const SHELL_VALUE_OPTIONS = new Set(['-o', '-O', '+o', '+O', '--init-file', '--rcfile']);
// pwsh options that take a value: the full name (any prefix of two or more characters
// selects it, as pwsh resolves unambiguous prefixes) plus the aliases pwsh documents.
const PWSH_VALUE_OPTIONS = {
  executionpolicy: ['ex', 'ep'], workingdirectory: ['wd', 'wo'], configurationname: ['config'], configurationfile: [],
  inputformat: ['if', 'inp'], outputformat: ['o', 'of'], windowstyle: ['w'], settingsfile: ['settings'], custompipename: [],
  version: ['v'], encodedarguments: ['encodeda', 'ea'],
};
const DQ_ESCAPABLE = new Set(['$', '`', '"', '\\', '\n']);
// PowerShell escapes that matter for statement counting resolve to their control character.
const PWSH_ESCAPES = { n: String.fromCharCode(10), r: String.fromCharCode(13) };
// How each tool's shell reads its command text: the escape character, whether backticks
// substitute, and whether braces open a scriptblock whose contents are commands too.
const DIALECTS = {
  Bash: { escape: '\\', substitutes: true, blocks: false, unescape: next => next },
  PowerShell: { escape: '`', substitutes: false, blocks: true, unescape: next => PWSH_ESCAPES[next] ?? next },
};
// How a -c or -Command body is read by the interpreter that receives it: its escape
// character, and whether a single & separates statements (bash) or calls (pwsh).
const BODY_SYNTAX = { shell: { escape: '\\', ampersand: true }, pwsh: { escape: '`', ampersand: false } };
const BODY_LIMIT = 200;

// Split into segments at unquoted |, |&, ||, &&, &, ;, newline, (, ), $( and
// backticks; split each segment into words, stripping quotes. Heredoc bodies
// are skipped so their content is never mistaken for commands; a herestring
// operand is dropped and marks the segment as fed from stdin.
function segments(command, dialect) {
  const { escape, substitutes, blocks, unescape } = dialect;
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
  // script argument. A PowerShell scriptblock ({ ... }) nests the same way,
  // but restores the block's source text instead, so a block passed as a
  // -Command body can still be counted. A bare ( ... ) group is a command
  // delimiter instead: it cuts the enclosing segment and only the quote
  // state is restored.
  const frames = [];
  const flush = () => { if (inWord && !dropWord) segment.words.push(word); if (inWord) dropWord = false; word = ''; inWord = false; };
  const cut = pipedIn => { flush(); result.push(segment); segment = { words: [], pipedIn, stdinFed: false }; dropWord = false; };
  const open = (closer, arithmetic, splice, start) => {
    if (!splice) cut(false);
    frames.push({ quote, closer, arithmetic, start, outer: splice ? { segment, word, inWord, dropWord } : null });
    quote = null; segment = { words: [], pipedIn: false, stdinFed: false }; word = ''; inWord = false; dropWord = false;
  };
  const close = end => {
    cut(false);
    const frame = frames.pop();
    quote = frame.quote;
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

const isAssignment = word => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
const isRedirection = word => /^(?:\d*[<>]{1,2}&?\d*|&>>?|\d*[<>]{1,2}&?\S+|&>>?\S+)$/.test(word);
const isOption = word => word.startsWith('-') && word !== '-';
const baseName = word => word.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
// pwsh resolves a switch from a documented alias or any unambiguous prefix of its name.
const isPwshSwitch = (arg, name, aliases) => { const key = arg.slice(1).toLowerCase(); return aliases.includes(key) || (key.length >= 2 && name.startsWith(key)); };
const isPwshValueOption = arg => Object.entries(PWSH_VALUE_OPTIONS).some(([name, aliases]) => isPwshSwitch(arg, name, aliases));
const isBashBodyFlag = arg => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg); // -c in any short-option cluster (-lc, -ec, -xc)

// Count the statements in a -c or -Command body as the receiving interpreter
// reads it: unquoted semicolons and newlines separate them (a single & too,
// where it backgrounds a command), so a separator inside a string literal
// does not count. Pipelines and && chains are one statement.
function statementCount(body, { escape, ampersand }) {
  let count = 0;
  let pending = false;
  let quote = null;
  const separates = index => {
    const char = body[index];
    if (char === ';' || char === '\n') return true;
    if (!ampersand || char !== '&') return false;
    return !/[&<>|]/.test(body[index - 1] ?? '') && !/[&>]/.test(body[index + 1] ?? '');
  };
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === escape && quote === '"') index++;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; pending = true; continue; }
    if (char === escape) { index++; pending = true; continue; }
    if (separates(index)) { if (pending) count++; pending = false; continue; }
    if (!/\s/.test(char)) pending = true;
  }
  return count + (pending ? 1 : 0);
}

// The verdict for a shell's -c or -Command body: a one-liner passes, as the rule allows it.
function classifyBody(name, flag, body, syntax) {
  if (body === undefined) return null;
  if (body === '-') return `${name} reading a program from stdin`;
  if (statementCount(body, syntax) > 1) return `${name} multi-statement inline body (${flag})`;
  if (body.length > BODY_LIMIT) return `${name} over-long inline body (${flag})`;
  return null;
}

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
  const family = /^(?:node|nodejs|bun)$/.test(name) ? 'node' : name === 'deno' ? 'deno' : /^(?:python(?:3(?:\.\d+)?)?|py)$/.test(name) ? 'python' : POSIX_SHELLS.has(name) ? 'shell' : POWERSHELLS.has(name) ? 'pwsh' : null;
  if (!family) return null;
  let expectValue = false;
  let subcommand = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (expectValue) { expectValue = false; continue; }
    if (isRedirection(arg)) continue;
    if (arg === '-') return `${name} reading a program from stdin`;
    if (family === 'shell' && SHELL_VALUE_OPTIONS.has(arg)) { expectValue = true; continue; } // includes the +o forms, which isOption does not see
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
    } else if (family === 'pwsh') {
      if (isPwshSwitch(arg, 'encodedcommand', ['e', 'ec'])) return `${name} encoded inline body (${arg})`;
      if (isPwshSwitch(arg, 'commandwithargs', ['cwa'])) return classifyBody(name, arg, args[index + 1], BODY_SYNTAX.pwsh); // the next word is the body, later words are its arguments
      if (isPwshSwitch(arg, 'command', ['c'])) return classifyBody(name, arg, index + 1 < args.length ? args.slice(index + 1).join(' ') : undefined, BODY_SYNTAX.pwsh); // the rest is the command
      if (isPwshValueOption(arg)) expectValue = true;
    } else if (isBashBodyFlag(arg)) {
      return classifyBody(name, arg, args[index + 1], BODY_SYNTAX.shell); // the next word is the body, later words are positionals
    }
  }
  const fed = segment.pipedIn || segment.stdinFed;
  if (family === 'deno') return fed && subcommand === 'run' ? 'deno reading a program from stdin' : null;
  return fed ? `${name} reading a program from stdin` : null;
}

function inspect(command, dialect) {
  if (typeof command !== 'string') return null;
  for (const segment of segments(command, dialect)) {
    const rule = classify(segment);
    if (rule) return { rule, snippet: segment.words.join(' ').slice(0, 120) };
  }
  return null;
}

let input;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); } // fail-open on an unexpected envelope
const tool = input?.tool_name;
if (typeof tool !== 'string' || !Object.hasOwn(DIALECTS, tool)) process.exit(0);
const found = inspect(input.tool_input?.command, DIALECTS[tool]);
if (!found) process.exit(0);
process.stderr.write(`Blocked by no-inline-scripts hook (${found.rule}): ${found.snippet}\nWrite the script body to a .tmp/ or scratchpad file with the Write tool and run it by path. Use jq for a single JSON field pick, and keep a pwsh -Command or bash -c argument to one statement. Heredocs and pipes may carry plain data into a script run by path, never the script itself, and no inline fallback may be chained after a script file.\n`);
process.exit(2);
