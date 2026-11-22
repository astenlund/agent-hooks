// PreToolUse hook (matcher: Bash|PowerShell): refuse a command that contains
// a directory change (cd, pushd, chdir, Set-Location, sl, Push-Location)
// alongside anything else, so the working directory never drifts behind the
// agent's back. Only a bare directory change, the whole command on its own,
// passes: that is how a drifted working directory is restored. The command is
// split by shell-segments.mjs, so wrappers, keywords and assignments ahead of
// the command word are seen through, a directory change inside a group,
// substitution or block is found wherever it sits, and a substitution or
// argument group inside the directory argument is part of the directory
// change rather than something alongside it. Active unless
// CLAUDE_NO_CD_CHAINS is 0 or false. Exits 2 with the reason on stderr to
// block; exits 0 on no match, when switched off, or on malformed input
// (fail-open). Registered by the plugin's hooks/hooks.json; self-test:
// node scripts/no-cd-chains.test.mjs
import { readFileSync } from 'node:fs';
import { DIALECTS, baseName, commandWords, segments } from './shell-segments.mjs';

const DIRECTORY_CHANGES = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl', 'push-location']);
const DISABLED_VALUES = new Set(['0', 'false']);

// Whether a segment sits in a frame that the owner segment's words opened, at any depth.
const nestedIn = (item, owner) => {
  for (let frame = item.scope; frame; frame = frame.parent) if (frame.owner === owner) return true;
  return false;
};

// In PowerShell a quoted string standing where a command would is a value, as in $label = 'cd', and names a command
// only behind the & call operator; in Bash quote removal leaves "cd" a command word.
const isDirectoryChange = (item, dialect) => {
  const words = commandWords(item.words);
  if (words.length === 0 || !DIRECTORY_CHANGES.has(baseName(words[0]))) return false;
  const at = item.words.length - words.length;
  const quotedValue = dialect === DIALECTS.PowerShell && !item.called && item.words[at] === words[0] && item.quoted[at];

  return !quotedValue;
};

// A directory change is bare when every other segment belongs to its own arguments. The outermost one is
// judged, since a directory change inside another's argument, as in cd "$(cd x && pwd)", is part of it.
function inspect(command, dialect) {
  if (typeof command !== 'string') return null;
  const found = segments(command, dialect);
  const changes = found.filter(item => isDirectoryChange(item, dialect));
  const change = changes.find(item => !changes.some(other => nestedIn(item, other)));
  if (!change || found.every(item => item === change || nestedIn(item, change))) return null;

  return change.words.join(' ').slice(0, 120);
}

let input;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); } // fail-open on an unexpected envelope
if (DISABLED_VALUES.has(String(process.env.CLAUDE_NO_CD_CHAINS ?? '').trim().toLowerCase())) process.exit(0);
const tool = input?.tool_name;
if (typeof tool !== 'string' || !Object.hasOwn(DIALECTS, tool)) process.exit(0);
const snippet = inspect(input.tool_input?.command, DIALECTS[tool]);
if (snippet === null) process.exit(0);
process.stderr.write(`Blocked by no-cd-chains hook (directory change combined with other commands): ${snippet}\nPass full paths to the command instead, or use git -C <dir> for Git, so the working directory never drifts. Only a bare directory change, the whole command on its own, is allowed, for restoring a drifted working directory.\n`);
process.exit(2);
