// PreToolUse hook (matcher: Bash|PowerShell): refuse a command in which a
// directory change (cd, pushd, chdir, Set-Location, sl, Push-Location) is
// followed by further commands that run in its context, so the working
// directory never drifts behind the agent's back. A directory change with
// nothing after it passes, whether it is the whole command or the last one:
// that is how a drifted working directory is restored. The command is split by
// shell-segments.mjs, so wrappers, keywords and assignments ahead of the
// command word are seen through, a directory change inside a group,
// substitution or block is found wherever it sits, and a substitution or
// argument group inside the directory argument is not counted as a chained
// command. Active unless CLAUDE_NO_CD_CHAINS is 0 or false. Exits 2 with the
// reason on stderr to block; exits 0 on no match, when switched off, or on
// malformed input (fail-open). Registered by the plugin's hooks/hooks.json;
// self-test: node scripts/no-cd-chains.test.mjs
import { readFileSync } from 'node:fs';
import { DIALECTS, baseName, commandWords, segments } from './shell-segments.mjs';

const DIRECTORY_CHANGES = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl', 'push-location']);
const DISABLED_VALUES = new Set(['0', 'false']);

// Whether a segment sits in a frame that the owner segment's words opened, at any depth.
const nestedIn = (item, owner) => {
  for (let frame = item.scope; frame; frame = frame.parent) if (frame.owner === owner) return true;
  return false;
};

// Whether a segment sits in the given frame or any frame nested inside it; every segment is within the top level.
const within = (item, scope) => {
  for (let frame = item.scope; ; frame = frame.parent) {
    if (frame === scope) return true;
    if (!frame) return false;
  }
};

// A directory change is chained when a segment after it in the source runs in
// its context, other than one in a frame its own words opened (its arguments).
// In Bash every frame is a subshell, so the context is the frame the directory
// change sits in and the frames nested there: a command after the enclosing
// frame, as in echo "$(cd x)"; ls, runs outside it and does not count. In
// PowerShell the location belongs to the runspace, so a Set-Location inside a
// group, block or subexpression moves every later command.
const isDirectoryChange = item => {
  const words = commandWords(item.words);

  return words.length > 0 && DIRECTORY_CHANGES.has(baseName(words[0]));
};
const isChained = (change, found, dialect) => {
  const context = dialect === DIALECTS.PowerShell ? null : change.scope;

  return found.some(item => item.order > change.order && within(item, context) && !nestedIn(item, change));
};

function inspect(command, dialect) {
  if (typeof command !== 'string') return null;
  const found = segments(command, dialect);
  const chained = found.filter(isDirectoryChange).find(change => isChained(change, found, dialect));

  return chained ? chained.words.join(' ').slice(0, 120) : null;
}

let input;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); } // fail-open on an unexpected envelope
if (DISABLED_VALUES.has(String(process.env.CLAUDE_NO_CD_CHAINS ?? '').trim().toLowerCase())) process.exit(0);
const tool = input?.tool_name;
if (typeof tool !== 'string' || !Object.hasOwn(DIALECTS, tool)) process.exit(0);
const snippet = inspect(input.tool_input?.command, DIALECTS[tool]);
if (snippet === null) process.exit(0);
process.stderr.write(`Blocked by no-cd-chains hook (directory change chained into further commands): ${snippet}\nPass full paths to the command instead, or use git -C <dir> for Git, so the working directory never drifts. A directory change with nothing after it, such as the whole command on its own, is still allowed for restoring a drifted working directory.\n`);
process.exit(2);
