// Self-test for no-cd-chains.mjs: spawns the hook by path with
// CLAUDE_NO_CD_CHAINS unset and a Bash tool envelope on stdin (or a
// PowerShell one, for a [command, tool] entry), and checks the exit code, the
// stderr marker and the elapsed time, plus the advice in one refusal and that
// the switch turns the hook off. Run from the repository root:
//   node scripts/no-cd-chains.test.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hook = join(dirname(fileURLToPath(import.meta.url)), 'no-cd-chains.mjs');
const MAX_MS = 2000;
const MARKER = 'Blocked by no-cd-chains hook';
const blocked = [
  // a directory change chained by every separator the shell reads
  'cd C:/Git/x && npm test',
  'cd C:/Git/x; git status',
  'cd C:/Git/x\nnpm test',
  'cd C:/Git/x || exit 1',
  'cd C:/Git/x & npm test',
  'cd C:/Git/x | cat',
  'cd C:/Git/x |& cat',
  'cd C:/Git/x && (make)',
  'cd C:/Git/x && (make && ls)',
  'cd C:/Git/x && pwsh -NoProfile -File C:/x/script.ps1',
  // every directory-change command, behind wrappers, keywords and assignments
  'pushd C:/Git/x && make && popd',
  'chdir C:/Git/x && ls',
  'CD C:/Git/x && ls',
  '"cd" C:/Git/x && ls',
  'command cd C:/Git/x && ls',
  'builtin cd C:/Git/x && ls',
  'command -p -- cd C:/Git/x && ls',
  'CDPATH= cd x && ls',
  'env --u X cd x && ls',
  'stdbuf --output L cd x && ls',
  "env -S 'cd x' && ls",
  'if cd C:/Git/x; then make; fi',
  '{ cd C:/Git/x; make; }',
  '(cd C:/Git/x && make)',
  // a substitution in the directory argument does not hide the chain after it
  'cd "$(git rev-parse --show-toplevel)" && npm test',
  'cd "$(cd C:/Git/x && pwd)"; ls',
  'cd `git rev-parse --show-toplevel`; npm test',
  // a directory change inside a substitution or block that opens the command
  '$(cd C:/Git/x && make) && ls',
  '`cd C:/Git/x; make`',
  '"$(cd C:/Git/x && make)" && ls',
  // a directory change anywhere in the command, alongside anything else, before or after it
  'a=1 b=2; cd C:/Git/x && make',
  'd=$(pwd); cd C:/Git/x; ls',
  'a=1\nb=2\ncd C:/Git/x\nmake',
  'git status && cd C:/Git/x && make',
  'x=1; ls; cd C:/Git/x; make',
  'cd C:/Git/x; echo $(pwd)',
  'ls && (cd C:/Git/x && make)',
  'git status && cd C:/Git/x',
  'd=C:/Git/x; cd $d',
  'if [ -d C:/Git/x ]; then cd C:/Git/x; fi',
  'test -d C:/Git/x && { cd C:/Git/x; }',
  'for d in a b; do cd $d; done',
  // a directory change in a substitution or group is not bare either, even confined to a subshell
  '`cd C:/Git/x`',
  'x=$(cd C:/Git/x && pwd)',
  'x=$(cd C:/Git/x && pwd); echo $x',
  'echo "$(cd C:/Git/x; pwd)"',
  '(cd C:/Git/x); ls',
  'x=$(cd C:/Git/x); ls',
  'echo "$(cd C:/Git/x)"; ls',
  ["$d = 'C:\\Git\\x'; Set-Location $d; dotnet test", 'PowerShell'],
  ["$d='C:\\Git\\x'; Set-Location $d; dotnet test", 'PowerShell'],
  ['[string]$d = (Join-Path $root src); Set-Location $d; dotnet build', 'PowerShell'],
  ['$env:X = 1; $n += 1; cd C:\\Git\\x; ls', 'PowerShell'],
  ['$d -eq 1; Set-Location C:\\Git\\x; ls', 'PowerShell'],
  ['Write-Host hi; & { Set-Location C:\\Git\\x; dotnet test }', 'PowerShell'],
  ["$d = 'C:\\Git\\x'; Set-Location $d", 'PowerShell'],
  ['Write-Host (Get-Location); Set-Location C:\\Git\\x', 'PowerShell'],
  ['(Set-Location C:\\Git\\x); ls', 'PowerShell'],
  ['& { Set-Location C:\\Git\\x }; dotnet test', 'PowerShell'],
  ['"$(Set-Location C:\\Git\\x)"; ls', 'PowerShell'],
  ['Write-Host (Set-Location C:\\Git\\x); ls', 'PowerShell'],
  ['dotnet test (Set-Location C:\\Git\\x)', 'PowerShell'],
  ['& { Set-Location C:\\Git\\x }', 'PowerShell'],
  ['. { Set-Location C:\\Git\\x }', 'PowerShell'],
  ['@(Set-Location C:\\Git\\x)', 'PowerShell'],
  // the same shapes issued through the PowerShell tool, in its dialect
  ['Set-Location C:\\Git\\x; dotnet test', 'PowerShell'],
  ['set-location -Path C:\\Git\\x\nGet-ChildItem', 'PowerShell'],
  ['sl C:\\Git\\x; Get-ChildItem', 'PowerShell'],
  ['cd C:\\Git\\x && git status', 'PowerShell'],
  ['chdir C:\\Git\\x; dir', 'PowerShell'],
  ['Push-Location C:\\Git\\x; try { dotnet build } finally { Pop-Location }', 'PowerShell'],
  ['pushd C:\\Git\\x; dotnet build; popd', 'PowerShell'],
  ['Set-Location (Join-Path $root src); dotnet build', 'PowerShell'],
  ['Set-Location (Join-Path $root src); (dotnet build)', 'PowerShell'],
  ['Set-Location C:\\Git\\x; (dotnet test)', 'PowerShell'],
  ['& { Set-Location C:\\Git\\x; dotnet test }', 'PowerShell'],
  ['. { Set-Location C:\\Git\\x; dotnet test }', 'PowerShell'],
  ['"$(Set-Location C:\\Git\\x; dotnet test)"; ls', 'PowerShell'],
  ['Set-Location (Join-Path $root src) -PassThru; dotnet build', 'PowerShell'],
  ['cd("C:\\Git\\x"); npm test', 'PowerShell'],
  ['Set-Location($path); make', 'PowerShell'],
  ['@(Set-Location C:\\Git\\x; dotnet test); ls', 'PowerShell'],
  ["$t = @'\nnotes\n'@; Set-Location C:\\Git\\x; ls", 'PowerShell'],
  ["Write-Output prefix@'\nnotes'; Set-Location .; Get-Location", 'PowerShell'],
];
// Commands models actually issued (from Claude Code transcripts, paths and identifiers generalized) that this hook
// must keep refusing; a reported slip is added here, and its fix is the narrowest change that catches it.
const encountered = [
  'd=C:/Git/x/.tmp/run; cd C:/Git/x 2>/dev/null; timeout 1500 codex exec resume 0000 -m model -c \'sandbox_mode="read-only"\' --json -o $d/review.md - < $d/resume.md > $d/review.jsonl 2> $d/review.err; echo "exit $?"',
  'G="D:/Games/Some Game"; cd "$G" 2>/dev/null; stat -c \'%y %n\' "$G"/ReShade.*',
  'cd C:/Git/x && grep -rn "pattern" src/a.ts src/b.ts | head -30',
  'cd C:/Git/x; git status --short; git log --oneline -3',
  'cd C:/Git/x/runtime && node --test --test-concurrency=1 test/cli.test.ts 2>&1 | tail -30',
  'cd C:/Git/x/runtime 2>/dev/null; node --test C:/Git/x/runtime/test/a.test.ts 2>&1 | tail -40',
  'cd /c/Git/x 2>/dev/null; timeout 590 node C:/Git/x/tools/pin.ts 2>&1 | tail -5',
  'cd /dev/null 2>/dev/null; grep -rn "pattern" C:/Git/x/src --include=*.go | cut -c1-200',
  'cd /dev/null 2>&1; grep -n "pattern" C:/Git/x/src/a.ts',
  'cd /c && grep -n "pattern" C:/Git/x/README.md',
  "cd C:/ ; git diff --no-index --word-diff=plain C:/x/a.md C:/x/b.md",
  'cd C:/Git/x/.tmp/run 2>/dev/null; true',
  'cd C:/Git/x/dev || exit 1',
  'cd "C:/Git/x/.nightshift/runs/c/0000"; ls; wc -l context/diff.patch',
  'cd C:/Git/x/.nightshift/runs/operations && ls -t | head -3 | while read d; do echo "== $d"; ls $d; done',
  'cd C:/Git/x; for f in README.md docs/a.md; do grep -c "pattern" "$f"; done',
  'mkdir -p C:/Git/x/.tmp/logs; cd C:/Git/x 2>/dev/null; node --test C:/Git/x/tests/a.test.js',
  'for f in $(cd C:/Git/x/.nightshift 2>/dev/null; ls *.md); do echo "== $f"; done',
  'for d in C:/Git/x/fixtures/*/; do (cd "$d" 2>/dev/null; true); find "$d" -type f; done',
  ['Set-Location C:/Git/x; node node_modules/eslint/bin/eslint.js src/a.js', 'PowerShell'],
  ['Set-Location C:/x/app; & "C:/x/tools/python.exe" -I scripts/a.py', 'PowerShell'],
  ['Push-Location C:/Git/x/.tmp/check; try { node probe/a.cjs 2>&1 | Select-String \'"label\' } finally { Pop-Location }', 'PowerShell'],
  ["$d='C:/Git/x/.tmp/run'; Push-Location C:/Git/x; try { node tools/release.js --write | Select-Object -Last 1 } finally { Pop-Location }", 'PowerShell'],
];
const allowed = [
  // a bare directory change restores a drifted working directory
  'cd C:/Git/x',
  'cd "C:/Program Files/x"',
  'cd',
  'cd -',
  'cd C:/Git/x;',
  'cd C:/Git/x\n',
  'cd C:/Git/x 2>/dev/null',
  'pushd C:/Git/x',
  'cd "$(git rev-parse --show-toplevel)"',
  'cd `git rev-parse --show-toplevel`',
  'cd "$(cd C:/Git/x && pwd)"',
  // full paths, git -C, and text or commands that merely look like cd
  'git -C C:/Git/x status',
  'npm test --prefix C:/Git/x',
  'echo cd x && ls',
  'git commit -m "cd x && ls"',
  'cdk deploy && ls',
  "printf '%s\\n' checking; command -v cd",
  'command -V cd && ls',
  'command -p -v cd && ls',
  'ls; cat x',
  ['Set-Location C:\\Git\\x', 'PowerShell'],
  ['Set-Location (Join-Path $root src) -PassThru', 'PowerShell'],
  ['cd("C:\\Git\\x")', 'PowerShell'],
  ['Set-Location -Path "C:\\Program Files\\x"', 'PowerShell'],
  ['Set-Location (Join-Path $root src)', 'PowerShell'],
  ['Push-Location C:\\Git\\x', 'PowerShell'],
  ['dotnet test C:\\Git\\x', 'PowerShell'],
  ['Write-Host "cd x; ls"', 'PowerShell'],
  ["Set-Content -Path C:/Git/x/NOTES.md -Value @'\nDon't run this from elsewhere.\nSet-Location C:/Git/repo\n'@", 'PowerShell'],
  ['$text = @"\nRun: cd C:/Git/x; npm test\n"@; Set-Content C:/Git/x/a.md $text', 'PowerShell'],
  ['git -C C:\\Git\\x status; dotnet build C:\\Git\\x', 'PowerShell'],
];

let failures = 0;
const { CLAUDE_NO_CD_CHAINS: _, ...defaultEnv } = process.env;
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
for (const entry of [...blocked, ...encountered]) {
  const result = run(entry);
  if (result.status !== 2 || !result.stderr.includes(MARKER)) { failures++; console.log('NOT BLOCKED:', JSON.stringify(entry), 'exit', result.status); }
  if (result.ms > MAX_MS) { failures++; console.log('SLOW:', JSON.stringify(entry), result.ms, 'ms'); }
}
for (const entry of allowed) {
  const result = run(entry);
  if (result.status !== 0) { failures++; console.log('WRONGLY BLOCKED:', JSON.stringify(entry), 'exit', result.status, result.stderr.trim().split('\n')[0]); }
  if (result.ms > MAX_MS) { failures++; console.log('SLOW:', JSON.stringify(entry), result.ms, 'ms'); }
}
// The refusal points at full paths and git -C.
const advice = run('cd C:/Git/x && npm test').stderr;
if (!advice.includes('full paths') || !advice.includes('git -C <dir>')) { failures++; console.log('MISSING ADVICE:', JSON.stringify(advice)); }
// The hook is on by default: 0 and false switch it off in any case; unset or any other value leaves it on.
const switches = [
  ['unset', defaultEnv, 2],
  ['empty', { ...defaultEnv, CLAUDE_NO_CD_CHAINS: '' }, 2],
  ['1', { ...defaultEnv, CLAUDE_NO_CD_CHAINS: '1' }, 2],
  ['no', { ...defaultEnv, CLAUDE_NO_CD_CHAINS: 'no' }, 2],
  ['0', { ...defaultEnv, CLAUDE_NO_CD_CHAINS: '0' }, 0],
  ['FALSE', { ...defaultEnv, CLAUDE_NO_CD_CHAINS: 'FALSE' }, 0],
];
for (const [name, env, expected] of switches) {
  const result = run('cd C:/Git/x && npm test', env);
  if (result.status !== expected) { failures++; console.log('WRONG SWITCH BEHAVIOR:', name, 'exit', result.status, 'expected', expected); }
}
const envelopes = [
  ['non-shell tool', JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'cd x && ls' } })],
  ['inherited property as a tool name', JSON.stringify({ tool_name: 'constructor', tool_input: { command: 'cd x && ls' } })],
  ['malformed JSON', 'not json'],
  ['empty stdin', ''],
  ['missing tool_input', JSON.stringify({ tool_name: 'Bash' })],
  ['non-string command', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 42 } })],
];
for (const [name, input] of envelopes) {
  const result = spawnHook(input, defaultEnv);
  if (result.status !== 0) { failures++; console.log('ENVELOPE NOT PASSED THROUGH:', name, 'exit', result.status); }
}
console.log(`${blocked.length} blocked, ${encountered.length} encountered, ${allowed.length} allowed, ${switches.length} switch, ${envelopes.length} envelope cases; failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
