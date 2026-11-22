// Self-test for no-sed-in-place.mjs: spawns the hook by path with
// CLAUDE_NO_SED_IN_PLACE unset and a Bash tool envelope on stdin (or a
// PowerShell one, for a [command, tool] entry), and checks the exit code, the
// stderr marker and the elapsed time, plus the advice in one refusal and that
// the switch turns the hook off. The hook only refuses on Windows, so on any
// other platform every case is expected to pass. Run from the repository root:
//   node scripts/no-sed-in-place.test.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hook = join(dirname(fileURLToPath(import.meta.url)), 'no-sed-in-place.mjs');
const MAX_MS = 2000;
const MARKER = 'Blocked by no-sed-in-place hook';
const REFUSES = process.platform === 'win32';
const blocked = [
  // -i in every short-option spelling, with or without a backup suffix
  "sed -i 's/a/b/' file.txt",
  "sed -i.bak 's/a/b/' file.txt",
  "sed -i'' 's/a/b/' file.txt",
  "sed -ni 's/a/b/p' file.txt",
  "sed -Ei 's/a+/b/' file.txt",
  "sed -in 's/a/b/' file.txt",
  "sed -ib 's/a/b/' file.txt", // b here is the backup suffix, not binary mode
  "sed -e 's/a/b/' -i file.txt",
  "sed -n -e 's/a/b/p' -i file.txt",
  "sed -f edit.sed -i file.txt",
  "sed -l 80 -i file.txt",
  "sed 's/a/b/' -i file.txt",
  // --in-place, its =SUFFIX form and unambiguous prefixes
  "sed --in-place 's/a/b/' file.txt",
  "sed --in-place=.bak 's/a/b/' file.txt",
  "sed --in 's/a/b/' file.txt",
  "sed --expression='s/a/b/' --in-place file.txt",
  "sed --expression 's/a/b/' -i file.txt",
  // every spelling of the command word, behind wrappers, keywords and assignments, in any segment
  "/usr/bin/sed -i 's/a/b/' file.txt",
  "sed.exe -i 's/a/b/' file.txt",
  "SED -i 's/a/b/' file.txt",
  "gsed -i 's/a/b/' file.txt",
  "LC_ALL=C sed -i 's/a/b/' file.txt",
  "git ls-files '*.md' | xargs sed -i 's/a/b/'",
  "git ls-files '*.md' | xargs --max-args 1 sed -i 's/a/b/'",
  "git ls-files '*.md' | xargs --arg-file list.txt --max-procs 4 sed -i 's/a/b/'",
  "git ls-files '*.md' | xargs --max-lines sed -i 's/a/b/'", // --max-lines takes its value only as --max-lines=N
  "git ls-files '*.md' | xargs --max-a 1 sed -i 's/a/b/'",
  "git ls-files '*.md' | xargs --del , --pro SLOT sed -i 's/a/b/'",
  "git ls-files '*.md' | xargs --max-l sed -i 's/a/b/'",
  "env -u X sed -i 's/a/b/' file.txt",
  "env --u X sed -i 's/a/b/' file.txt",
  "env --split-string 'X=1' sed -i 's/a/b/' file.txt",
  "timeout --sig KILL --kill 5 10 sed -i 's/a/b/' file.txt",
  "nice --adj 5 sed -i 's/a/b/' file.txt",
  "stdbuf --output L sed -i 's/a/b/' file.txt",
  "stdbuf --o L sed -i 's/a/b/' file.txt",
  "env - /usr/bin/sed -i 's/a/b/' file.txt",
  // env -S splits its value into the start of the command line
  "env -S sed -i 's/a/b/' file.txt",
  "env -S 'sed -i s/a/b/' file.txt",
  "env -S'sed -i' 's/a/b/' file.txt",
  "env --split-string='sed -i s/a/b/' file.txt",
  "env --sp 'X=1 sed -i' 's/a/b/' file.txt",
  "command sed -i 's/a/b/' file.txt",
  "git status && sed -i 's/a/b/' file.txt",
  "grep -q a file.txt || sed -i 's/a/b/' file.txt",
  "for f in *.md; do sed -i 's/a/b/' \"$f\"; done",
  "if true; then sed -i 's/a/b/' file.txt; fi",
  "x=$(sed -i 's/a/b/' file.txt)",
  // the command lists find runs per match
  "find . -name '*.md' -exec sed -i 's/a/b/' {} +",
  "find . -name '*.md' -exec sed -i 's/a/b/' {} \\;",
  "find . -type f -execdir sed -i 's/a/b/' {} ';'",
  "find . -ok sed --in-place 's/a/b/' {} \\;",
  "find . -okdir sed -i 's/a/b/' {} \\;",
  "find . -ok sed -e x {} + -i \\;", // -ok ends only at ;, so the + and -i are sed's
  "find . -exec grep -q a {} \\; -exec sed -i 's/a/b/' {} +",
  "/usr/bin/find . -exec env LC_ALL=C sed -i 's/a/b/' {} +",
  "find . -exec sed -E 's/a/b/' + -i {} \\;", // a + not right after {} is an argument, so -i belongs to sed
  // the same shapes issued through the PowerShell tool
  ["sed -i 's/a/b/' C:\\Git\\x\\file.txt", 'PowerShell'],
  ["Get-ChildItem *.md | ForEach-Object { sed -i 's/a/b/' $_.FullName }", 'PowerShell'],
  ["& sed --in-place 's/a/b/' file.txt", 'PowerShell'],
  ["find . -exec sed -i 's/a/b/' '{}' ';'", 'PowerShell'],
  ["find . -exec sed -i 's/a/b/' {} ;", 'PowerShell'], // an unquoted ; ends the segment, and with it the action
];
const allowed = [
  // sed without in-place editing
  "sed 's/a/b/' file.txt",
  "sed -n '1,5p' file.txt",
  "sed -e 's/a/b/' file.txt > out.txt",
  "cat file.txt | sed 's/a/b/'",
  "sed --version",
  // binary mode keeps every CR
  "sed -b -i 's/a/b/' file.txt",
  "sed -bi 's/a/b/' file.txt",
  "sed -i -b 's/a/b/' file.txt",
  "sed --binary --in-place 's/a/b/' file.txt",
  "sed --bin -i 's/a/b/' file.txt",
  // an i inside a value is not the -i option
  "sed -ei file.txt",
  "sed -e -i file.txt",
  "sed -f -i file.txt",
  "sed --expression -i file.txt",
  "sed -l -i file.txt",
  "sed -V -i file.txt",
  "sed -Vi file.txt",
  "sed 's/a/b/' -- -i",
  // find runs sed without in-place editing, in binary mode, or not at all
  "find . -name '*.md' -exec sed 's/a/b/' {} +",
  "find . -exec sed -b -i 's/a/b/' {} +",
  "find . -name sed -print",
  "find . -exec grep -l sed {} +",
  "find . -exec echo sed -i {} \\;",
  "find . -exec grep -q a {} \\; -print -i",
  "find . -exec echo + -exec sed -i x {} \\;", // the second -exec is an argument of echo
  "find . -ok echo {} + -exec sed -i x {} \\;", // -ok runs only echo, up to the ;
  // ambiguous long prefixes select nothing
  "sed --s 's/a/b/' file.txt",
  // text that merely mentions sed -i, and other commands with -i
  "echo sed -i",
  "git commit -m \"sed -i s/a/b/ file.txt\"",
  "grep -i pattern file.txt",
  "perl -pi -e 's/a/b/' file.txt",
  "sedx -i file.txt",
  ["Write-Host 'sed -i s/a/b/ file.txt'", 'PowerShell'],
  ["sed 's/a/b/' C:\\Git\\x\\file.txt", 'PowerShell'],
];

let failures = 0;
const { CLAUDE_NO_SED_IN_PLACE: _, ...defaultEnv } = process.env;
const spawnHook = (input, env) => {
  const started = Date.now();
  const result = spawnSync(process.execPath, [hook], { input, env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return { ...result, ms: Date.now() - started };
};
const envelope = (command, tool = 'Bash') => JSON.stringify({ tool_name: tool, tool_input: { command } });
const run = (entry, env = defaultEnv) => {
  const [command, tool] = Array.isArray(entry) ? entry : [entry, 'Bash'];
  return spawnHook(envelope(command, tool), env);
};
for (const entry of blocked) {
  const result = run(entry);
  const refused = result.status === 2 && result.stderr.includes(MARKER);
  if (REFUSES && !refused) { failures++; console.log('NOT BLOCKED:', JSON.stringify(entry), 'exit', result.status); }
  if (!REFUSES && result.status !== 0) { failures++; console.log('BLOCKED OFF WINDOWS:', JSON.stringify(entry), 'exit', result.status); }
  if (result.ms > MAX_MS) { failures++; console.log('SLOW:', JSON.stringify(entry), result.ms, 'ms'); }
}
for (const entry of allowed) {
  const result = run(entry);
  if (result.status !== 0) { failures++; console.log('WRONGLY BLOCKED:', JSON.stringify(entry), 'exit', result.status, result.stderr.trim().split('\n')[0]); }
  if (result.ms > MAX_MS) { failures++; console.log('SLOW:', JSON.stringify(entry), result.ms, 'ms'); }
}
// The refusal points at the Edit tool and at a byte-level script for escape sequences.
if (REFUSES) {
  const advice = run("sed -i 's/a/b/' file.txt").stderr;
  if (!advice.includes('Edit tool') || !advice.includes('byte-level script') || !advice.includes('code point')) { failures++; console.log('MISSING ADVICE:', JSON.stringify(advice)); }
}
// The hook is on by default: 0 and false switch it off in any case; unset or any other value leaves it on.
const on = REFUSES ? 2 : 0;
const switches = [
  ['unset', defaultEnv, on],
  ['empty', { ...defaultEnv, CLAUDE_NO_SED_IN_PLACE: '' }, on],
  ['1', { ...defaultEnv, CLAUDE_NO_SED_IN_PLACE: '1' }, on],
  ['no', { ...defaultEnv, CLAUDE_NO_SED_IN_PLACE: 'no' }, on],
  ['0', { ...defaultEnv, CLAUDE_NO_SED_IN_PLACE: '0' }, 0],
  ['FALSE', { ...defaultEnv, CLAUDE_NO_SED_IN_PLACE: 'FALSE' }, 0],
  [' false ', { ...defaultEnv, CLAUDE_NO_SED_IN_PLACE: ' false ' }, 0],
];
for (const [name, env, expected] of switches) {
  const result = run("sed -i 's/a/b/' file.txt", env);
  if (result.status !== expected) { failures++; console.log('WRONG SWITCH BEHAVIOR:', name, 'exit', result.status, 'expected', expected); }
}
const envelopes = [
  ['non-shell tool', JSON.stringify({ tool_name: 'Read', tool_input: { file_path: "sed -i 's/a/b/' x" } })],
  ['inherited property as a tool name', JSON.stringify({ tool_name: 'constructor', tool_input: { command: "sed -i 's/a/b/' x" } })],
  ['malformed JSON', 'not json'],
  ['empty stdin', ''],
  ['missing tool_input', JSON.stringify({ tool_name: 'Bash' })],
  ['non-string command', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 42 } })],
];
for (const [name, input] of envelopes) {
  const result = spawnHook(input, defaultEnv);
  if (result.status !== 0) { failures++; console.log('ENVELOPE NOT PASSED THROUGH:', name, 'exit', result.status); }
}
console.log(`${blocked.length} blocked, ${allowed.length} allowed, ${switches.length} switch, ${envelopes.length} envelope cases; failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
