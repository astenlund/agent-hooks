// PreToolUse hook (matcher: Bash|PowerShell): on Windows, refuse an in-place
// sed edit in text mode. Git Bash sed reads in text mode, so sed -i drops
// each line's trailing CR, rewriting a CRLF file to LF even when nothing matches.
// The command is split by shell-segments.mjs, so sed is found behind
// wrappers (xargs, env, ...), keywords and assignments, and in any segment.
// In-place is -i in any short-option cluster (-i, -i.bak, -ni, -Ei) or
// --in-place, also as an unambiguous prefix (--in) and with =SUFFIX; a value
// taken by -e, -f, -l or -V, or by --expression, --file or --line-length
// (attached or as the next word), is not an option, and nothing after -- counts.
// Binary mode (-b, --binary) keeps every CR, so sed -b -i passes. Other
// platforms pass everything. Active unless CLAUDE_NO_SED_IN_PLACE is 0 or
// false. Exits 2 with the reason on stderr to block; exits 0 on no match,
// when switched off, off Windows, or on malformed input (fail-open).
// Registered by the plugin's hooks/hooks.json; self-test:
// node scripts/no-sed-in-place.test.mjs
import { readFileSync } from 'node:fs';
import { DIALECTS, baseName, commandWords, segments } from './shell-segments.mjs';

const SEDS = new Set(['sed', 'gsed']);
const DISABLED_VALUES = new Set(['0', 'false']);
// Short options whose value is the rest of the cluster or, when nothing follows, the next word
// (V is undocumented in GNU sed 4.9 but takes a value all the same).
const SHORT_VALUE_OPTIONS = new Set(['e', 'f', 'l', 'V']);
// Long options that take a value; GNU sed accepts any unambiguous prefix of a long option name.
const LONG_VALUE_OPTIONS = ['expression', 'file', 'line-length'];
const LONG_OPTIONS = ['in-place', 'binary', 'expression', 'file', 'line-length', 'quiet', 'silent', 'debug', 'posix', 'regexp-extended', 'separate', 'sandbox', 'unbuffered', 'null-data', 'zero-terminated', 'follow-symlinks', 'help', 'version'];

// The long option a --name argument selects, or null when it is unknown or ambiguous.
function longOption(name) {
  if (LONG_OPTIONS.includes(name)) return name;
  const matches = LONG_OPTIONS.filter(option => option.startsWith(name));

  return matches.length === 1 ? matches[0] : null;
}

// Whether a sed invocation's arguments edit in place without binary mode.
function editsInPlace(args) {
  let inPlace = false;
  let binary = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') break;
    if (arg.startsWith('--')) {
      const option = longOption(arg.slice(2).split('=')[0]);
      if (option === 'in-place') inPlace = true;
      else if (option === 'binary') binary = true;
      else if (LONG_VALUE_OPTIONS.includes(option) && !arg.includes('=')) index++; // the next word is the value
      continue;
    }
    if (!arg.startsWith('-') || arg === '-') continue;
    for (let position = 1; position < arg.length; position++) {
      const flag = arg[position];
      if (flag === 'i') { inPlace = true; break; } // the rest of the cluster is the backup suffix
      if (flag === 'b') binary = true;
      if (SHORT_VALUE_OPTIONS.has(flag)) {
        if (position === arg.length - 1) index++;
        break;
      }
    }
  }

  return inPlace && !binary;
}

function inspect(command, dialect) {
  if (typeof command !== 'string') return null;
  for (const segment of segments(command, dialect)) {
    const words = commandWords(segment.words);
    if (words.length > 0 && SEDS.has(baseName(words[0])) && editsInPlace(words.slice(1))) return segment.words.join(' ').slice(0, 120);
  }

  return null;
}

let input;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); } // fail-open on an unexpected envelope
if (process.platform !== 'win32') process.exit(0);
if (DISABLED_VALUES.has(String(process.env.CLAUDE_NO_SED_IN_PLACE ?? '').trim().toLowerCase())) process.exit(0);
const tool = input?.tool_name;
if (typeof tool !== 'string' || !Object.hasOwn(DIALECTS, tool)) process.exit(0);
const snippet = inspect(input.tool_input?.command, DIALECTS[tool]);
if (snippet === null) process.exit(0);
process.stderr.write(`Blocked by no-sed-in-place hook (in-place sed edit in text mode): ${snippet}\nGit Bash sed reads in text mode, so sed -i rewrites a CRLF file to LF even when nothing is substituted. Make the edit with the Edit tool. When the edit involves an escape sequence the Edit tool would decode, write a byte-level script to a file and run it by path, building each backslash from its code point (chr(92), [char]92, String.fromCharCode(92)) rather than typing it. sed -b -i keeps every CR, but then a pattern anchored on $ must match the CR explicitly.\n`);
process.exit(2);
