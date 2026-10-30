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
  'CDPATH= cd x && ls',
  'if cd C:/Git/x; then make; fi',
  '{ cd C:/Git/x; make; }',
  '(cd C:/Git/x && make)',
  // a substitution in the directory argument does not hide the chain after it
  'cd "$(git rev-parse --show-toplevel)" && npm test',
  'cd `git rev-parse --show-toplevel`; npm test',
  // a substitution or block that opens the command runs its leading directory change first
  '$(cd C:/Git/x && make) && ls',
  '`cd C:/Git/x; make`',
  '"$(cd C:/Git/x && make)" && ls',
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
];
const allowed = [
  // a standalone directory change restores a drifted working directory
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
  '`cd C:/Git/x`',
  // full paths, git -C, and text or commands that merely look like cd
  'git -C C:/Git/x status',
  'npm test --prefix C:/Git/x',
  'echo cd x && ls',
  'git commit -m "cd x && ls"',
  'cdk deploy && ls',
  'ls; cat x',
  // only the first segment is inspected
  'git status && cd C:/Git/x',
  'x=$(cd C:/Git/x && pwd)',
  'echo "$(cd C:/Git/x; pwd)"',
  ['Set-Location C:\\Git\\x', 'PowerShell'],
  ['& { Set-Location C:\\Git\\x }', 'PowerShell'],
  ['. { Set-Location C:\\Git\\x }', 'PowerShell'],
  ['Set-Location (Join-Path $root src) -PassThru', 'PowerShell'],
  ['cd("C:\\Git\\x")', 'PowerShell'],
  ['@(Set-Location C:\\Git\\x)', 'PowerShell'],
  ['Write-Host (Get-Location); Set-Location C:\\Git\\x', 'PowerShell'],
  ['Set-Location -Path "C:\\Program Files\\x"', 'PowerShell'],
  ['Set-Location (Join-Path $root src)', 'PowerShell'],
  ['Push-Location C:\\Git\\x', 'PowerShell'],
  ['dotnet test C:\\Git\\x', 'PowerShell'],
  ['Write-Host "cd x; ls"', 'PowerShell'],
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
for (const entry of blocked) {
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
console.log(`${blocked.length} blocked, ${allowed.length} allowed, ${switches.length} switch, ${envelopes.length} envelope cases; failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
