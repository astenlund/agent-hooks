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
  // a comment ends at its line, or at the backtick closing its substitution, and # inside a word is literal
  'cd C:/Git/x # restore\nmake',
  'cd `echo C:/Git/x # note`; make',
  'echo $# && cd C:/Git/x',
  'echo `echo ok # \\` x`; cd C:/Git/x',
  'echo $(pwd)#x; cd C:/Git/x',
  ['Set-Location C:\\Git\\x <# note #>; ls', 'PowerShell'],
  // a heredoc ends at its delimiter after quote removal, and an unquoted body runs its substitutions
  'cat <<\\EOF\nliteral text\nEOF\ncd C:/Git/x; pwd',
  'cat <<E"O"F\nliteral text\nEOF\ncd C:/Git/x; pwd',
  'cat <<EOF\n$(cd C:/Git/x; pwd)\nEOF',
  'cat <<EOF\n`cd C:/Git/x`\nEOF',
  'cat <<EOF\n$(cd C:/Git/x)',
  "cat <<'EOF' \"$(printf x\ncd .; pwd\n)\"\ndata\nEOF",
  "cat <<'EO'F\ndata\nEOF\ncd .; pwd",
  'cat <<EOF\nEO\\\nF\ncd .; pwd',
  'cat <<-EOF\n\tdata\n\tEOF\ncd .; pwd',
  'echo $(( $(cd C:/Git/x; pwd) + 1 ))',
  'cat <<"E\\\\OF"\ndata\nE\\OF\ncd .; pwd',
  'cat <<"E\\$OF"\ndata\nE$OF\ncd .; pwd',
  'cat <<"E\\"OF"\ndata\nE"OF\ncd .; pwd',
  'cat <<EOF\n$\\\n(cd .; pwd)\nEOF',
  'echo $(( (1 << 2\n) ))\ncd .; pwd',
  ['$((Set-Location .)); Get-Location', 'PowerShell'],
  ['Write-Output prefix$(Write-Output ok)#suffix; Set-Location .', 'PowerShell'],
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
  'd=C:/Git/x/.tmp/run; cd C:/Git/x 2>/dev/null; timeout 1500 codex exec - < $d/in.md > $d/out.jsonl; echo "exit $?"',
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
];
const allowed = [
  // comment text is never read as commands
  'cd C:/Git/x # restore; then run',
  'git status # then; cd C:/Git/x; ls',
  ['Write-Output ok # note; Set-Location .', 'PowerShell'],
  ['Set-Location C:\\Git\\x <# note; ls #>', 'PowerShell'],
  ['Get-ChildItem <# unclosed; Set-Location x', 'PowerShell'],
  'echo `echo ok # \\`; cd .;`',
  ['& { Write-Output ok }# note; Set-Location .', 'PowerShell'],
  ["Write-Output $('sub')# note; Set-Location .", 'PowerShell'],
  // a quoted heredoc body is literal, and an unquoted one only runs its substitutions
  "cat <<'EOF' > x.txt\n$(cd C:/Git/x; pwd)\nEOF",
  'cat <<\\EOF > x.txt\n$(cd C:/Git/x; pwd)\nEOF',
  'cat <<EOF > x.txt\n"quoted" text with cd x; ls\nEOF',
  'cat <<EOF > x.txt\nprice \\$(cd x; pwd)\nEOF',
  "cat <<'EOF' > x.txt\nEOF \ncd .; pwd\nEOF",
  "cat <<'EOF' > x.txt\n\tEOF\ncd .; pwd\nEOF",
  'cat <<EOF > x.txt\n$((cd + 1))\nEOF',
  "git commit -m \"$(cat <<'EOF'\nfix: cd x; ls\nEOF\n)\"",
  "cat <<'EOF' | (\ncd .; pwd\nEOF\ncat\n)",
  // arithmetic holds expressions, not commands
  'echo $((cd + 1))',
  'echo $(( (cd + 1) * 2 ))',
  // a bare directory change restores a drifted working directory
  'cd C:/Git/x',
  'cd "C:/Program Files/x"',
  'cd',
  'cd -',
  'cd C:/Git/x;',
  'cd C:/Git/x &',
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
  'ls; cat x',
  ['Set-Location C:\\Git\\x', 'PowerShell'],
  ['Set-Location (Join-Path $root src) -PassThru', 'PowerShell'],
  ['cd("C:\\Git\\x")', 'PowerShell'],
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
