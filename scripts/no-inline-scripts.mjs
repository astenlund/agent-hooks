// PreToolUse hook (matcher: Bash|PowerShell): refuse inline interpreter
// bodies so script text never passes through shell quoting layers. The
// command is split into pipeline segments and shell words in the tool's
// dialect by shell-segments.mjs, then each segment's command word is
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
// one-statement -c or -Command body passes, because a single short command
// handed to a shell is not a script body; the statement and length limits
// are a mechanical floor, not approval of everything that fits under them.
// A segment with a script argument passes, including a plain-data heredoc
// or pipe feeding that script.
// Exits 2 with the reason on stderr to block; exits 0 on no match or
// malformed input (fail-open). Registered by the plugin's hooks/hooks.json;
// self-test: node scripts/no-inline-scripts.test.mjs
import { readFileSync } from 'node:fs';
import { DIALECTS, baseName, commandWords, isOption, isRedirection, segments } from './shell-segments.mjs';

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
// How a -c or -Command body is read by the interpreter that receives it: its escape
// character, and whether a single & separates statements (bash) or calls (pwsh).
const BODY_SYNTAX = { shell: { escape: '\\', ampersand: true }, pwsh: { escape: '`', ampersand: false } };
const BODY_LIMIT = 200;

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

// The verdict for a shell's -c or -Command body: a single short command is not a script body, so it passes.
function classifyBody(name, flag, body, syntax) {
  if (body === undefined) return null;
  if (body === '-') return `${name} reading a program from stdin`;
  if (statementCount(body, syntax) > 1) return `${name} multi-statement inline body (${flag})`;
  if (body.length > BODY_LIMIT) return `${name} over-long inline body (${flag})`;
  return null;
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
process.stderr.write(`Blocked by no-inline-scripts hook (${found.rule}): ${found.snippet}\nWrite the script body to a file in your session's own scratch folder or the host's session scratchpad with the Write tool and run it by path. Use jq for a single JSON field pick, and keep a pwsh -Command or bash -c argument to one statement. Heredocs and pipes may carry plain data into a script run by path, never the script itself, and no inline fallback may be chained after a script file.\n`);
process.exit(2);
