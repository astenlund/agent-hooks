// PreToolUse hook (matcher: Bash|PowerShell): refuse a command whose
// first segment is a directory change (cd, pushd, chdir, Set-Location, sl,
// Push-Location) chained into further commands, so the working directory
// never drifts behind the agent's back. A standalone directory change, the
// whole command on its own, passes: that is how a drifted working directory
// is restored. The command is split by shell-segments.mjs, so wrappers,
// keywords and assignments ahead of the command word are seen through, as are
// assignment-only statements ahead of the directory change, a
// directory change leading a substitution or block that opens the command
// (quoted, an @(...) array subexpression, or invoked with & or a dot) is
// found, and a substitution or argument group inside the directory argument
// is not counted as a chained command. Active unless CLAUDE_NO_CD_CHAINS is
// 0 or false. Exits 2 with the reason on stderr to block; exits 0 on no
// match, when switched off, or on malformed input (fail-open). Registered by
// the plugin's hooks/hooks.json; self-test: node scripts/no-cd-chains.test.mjs
import { readFileSync } from 'node:fs';
import { DIALECTS, baseName, commandWords, isAssignment, segments } from './shell-segments.mjs';

const DIRECTORY_CHANGES = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl', 'push-location']);
const DISABLED_VALUES = new Set(['0', 'false']);

// Whether a segment sits in a frame that the owner segment's words opened, at any depth.
const nestedIn = (item, owner) => {
  for (let frame = item.scope; frame; frame = frame.parent) if (frame.owner === owner) return true;
  return false;
};

// A statement that only assigns variables: every word a Bash assignment, or a
// PowerShell variable (optionally type-cast) followed by an assignment operator.
const PWSH_VARIABLE = /^(?:\[[^\]]*\])*\$[A-Za-z_][\w:]*/;
const PWSH_OPERATOR = /^(?:[+\-*/%]|\?\?)?=/;
const isAssignmentOnly = (words, dialect) => {
  if (dialect !== DIALECTS.PowerShell) return words.every(isAssignment);
  const variable = words[0].match(PWSH_VARIABLE)?.[0];
  if (!variable) return false;
  const rest = words[0].slice(variable.length);

  return rest === '' ? PWSH_OPERATOR.test(words[1] ?? '') : PWSH_OPERATOR.test(rest);
};

// The first command the shell runs is the earliest segment that opens with a
// word, since a segment opening with a substitution or block runs that frame's
// commands first. Leading assignment-only statements, with the substitutions in
// them, are a preamble passed over, so the directory change behind them is
// still the first command. It is refused when it is a directory change and any
// other segment, outside the preamble, its own arguments and the frames around
// it, follows.
function inspect(command, dialect) {
  if (typeof command !== 'string') return null;
  const found = segments(command, dialect);
  const leading = found.filter(item => !item.opensWithFrame).sort((a, b) => a.order - b.order);
  const preamble = [];
  const inPreamble = item => preamble.some(entry => item === entry || nestedIn(item, entry));
  const first = leading.find(item => {
    if (inPreamble(item)) return false;
    if (!isAssignmentOnly(item.words, dialect)) return true;
    preamble.push(item);

    return false;
  });
  if (!first) return null;
  const words = commandWords(first.words);
  if (words.length === 0 || !DIRECTORY_CHANGES.has(baseName(words[0]))) return null;
  if (!found.some(item => item !== first && !inPreamble(item) && !nestedIn(item, first) && !nestedIn(first, item))) return null;

  return first.words.join(' ').slice(0, 120);
}

let input;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); } // fail-open on an unexpected envelope
if (DISABLED_VALUES.has(String(process.env.CLAUDE_NO_CD_CHAINS ?? '').trim().toLowerCase())) process.exit(0);
const tool = input?.tool_name;
if (typeof tool !== 'string' || !Object.hasOwn(DIALECTS, tool)) process.exit(0);
const snippet = inspect(input.tool_input?.command, DIALECTS[tool]);
if (snippet === null) process.exit(0);
process.stderr.write(`Blocked by no-cd-chains hook (directory change chained into further commands): ${snippet}\nPass full paths to the command instead, or use git -C <dir> for Git, so the working directory never drifts. A directory change on its own, as the whole command, is still allowed for restoring a drifted working directory.\n`);
process.exit(2);
