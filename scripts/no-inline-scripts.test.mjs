// Self-test for no-inline-scripts.mjs: spawns the hook by path with a Bash
// tool envelope on stdin and checks the exit code, the stderr marker and
// the elapsed time. Run from the repository root:
//   node scripts/no-inline-scripts.test.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hook = join(dirname(fileURLToPath(import.meta.url)), 'no-inline-scripts.mjs');
const MAX_MS = 2000;
const blocked = [
  // node family: inline flags in every position and quoting the shell allows
  'node -e "const r=JSON.parse(require(\'fs\').readFileSync(0,\'utf8\'));console.log(r.x)"',
  'cat out.json | node -e "const r=JSON.parse(require(\'fs\').readFileSync(0,\'utf8\'));console.log(r)"',
  'node C:/x/helper.js a b || node -e "console.log(1)"',
  'node --eval "1+1"',
  'node --eval="1+1"',
  'node -p "process.versions.node"',
  'node -pe "1"',
  'node.exe -e "1"',
  'node "-e" "1"',
  'MSYS_NO_PATHCONV=1 node -e "1"',
  'env FOO=1 node -e "1"',
  'node --input-type=module -e "import x from \'y\'"',
  'node -r dotenv/config -e "x"',
  'node --require ./setup.js --eval "x"',
  '/usr/bin/node -e "1"',
  '"C:/Program Files/nodejs/node.exe" -e "1"',
  'bun -e "1"',
  'deno eval "1"',
  'npm test && node -e "2"',
  '(node -e "1")',
  'x=$(node -e "console.log(1)")',
  'echo `node -p 1`',
  // python: -c in every spelling, including attached bodies and clusters
  'python -c "print(1)"',
  'python3 -c "import sys; print(sys.argv)"',
  'python3.12 -c "print(1)"',
  'py -3 -c "print(1)"',
  'python -Bc "print(1)"',
  "python -c'print(1)'",
  'python -cprint(1)',
  // a program read from stdin is an inline body too
  'node <<\'EOF\'\nconsole.log(1)\nEOF',
  'python - <<EOF\nprint(1)\nEOF',
  'python <<EOF\nprint(1)\nEOF',
  'bash <<\'EOF\'\necho hi\nEOF',
  'bash 2>&1 <<\'EOF\'\necho hi\nEOF',
  'pwsh -NoProfile <<\'EOF\'\nGet-Date\nEOF',
  'cat <<\'EOF\' | node\nconsole.log(1)\nEOF',
  'cat <<\'EOF\' | python -\nprint(1)\nEOF',
  'echo "print(1)" | python',
  'printf "console.log(1)" | node',
  'cat script.js | node --enable-source-maps',
  'cat script.js |& node',
  'node -',
  'node <<< "console.log(1)"',
  'sh <<EOF\necho hi\nEOF',
  'zsh <<EOF\necho hi\nEOF',
  'powershell -NoProfile <<EOF\nGet-Date\nEOF',
  'bash &>/dev/null <<EOF\necho hi\nEOF',
  'cat x.ts | deno run -',
  'cat x.ts | deno run',
  'deno --quiet eval "1"',
  // shapes ahead of the command word: keywords, wrappers, earlier herestrings
  'if node -e "1"; then echo y; fi',
  'if ! node -e "1"; then echo y; fi',
  'for f in *.json; do node -e "console.log(1)" "$f"; done',
  'while true; do python -c "print(1)"; done',
  '{ node -e "1"; }',
  '! node -e "1"',
  'timeout 30 node -e "1"',
  'find . | xargs node -e "1"',
  'sudo -u me node -e "1"',
  'env -i node -e "1"',
  'nice -n 10 node -e "1"',
  'cat <<< "x"\nnode -e "1"',
  'read -r v <<< "$x"\necho "$v"\nnode -e "1"',
  '"C:\\Program Files\\nodejs\\node.exe" -e "1"',
  // substitutions inside double quotes, arithmetic shifts, function bodies, remaining wrappers
  'echo "version: $(node -p \'process.version\')"',
  'v="$(node -e \'console.log(1)\')"',
  'echo "v=$(python -c \'print(1)\')"',
  'echo "`node -e 1`"',
  'grep x <<< "$(node -e 1)"',
  'cat <<< $(node -e "1")',
  'echo "$(date)"; node -e "1"',
  'echo "a $(echo "b $(node -e 1)")"',
  'function f { node -e "1"; }',
  'f() { node -e "1"; }',
  'case $x in (a) node -e "1";; esac',
  'case $x in a) node -e "1";; esac',
  '(cd C:/x && node -e "1")',
  'echo $((1<<2))\nnode -e "1"',
  'stdbuf -oL node -e "1"',
  'deno repl --eval "console.log(1)"',
  'node -e "$(unclosed',
  'echo "$(node -e 1',
];
const allowed = [
  'node --test tests/setup.test.js',
  'node skills/ready/ready.js C:/Git/nightshift',
  'node "C:/Users/me/.claude/plugins/cache/x/internal/runtime/cli.js" C:/Git/x C:/tmp/request.json',
  'node C:/Git/x/tools/release-gate.js --baseline abc --head HEAD',
  'node -r dotenv/config app.js',
  'node --enable-source-maps dist/main.js',
  'node --input-type=module app.mjs',
  'node --version',
  'node server.js -p 3000',
  'node cli.js -e production',
  'node x.js \\\n        --flag a \\\n        --flag b \\\n        --flag c',
  'node' + ' '.repeat(40) + 'x.js',
  'npm run build',
  'npx eslint .',
  'git commit -m "fix: thing" -- file.js',
  'git commit -m "use node -e less"',
  'echo node -e is banned',
  'echo hello',
  'grep -e pattern file.txt',
  'sed -e "s/a/b/" file.txt',
  'sed -n "1,5p" file.txt',
  'cat <<\'EOF\' > data.txt\nplain data\nEOF',
  'cat <<\'EOF\' > data.txt\nnode -e "looks inline but is data"\nEOF',
  'python read.py <<EOF\n{"a":1}\nEOF',
  'node read-stdin.js <<\'EOF\'\nplain data\nEOF',
  'bash script.sh <<EOF\ninput\nEOF',
  'pwsh -NoProfile -File C:/x/.tmp/script.ps1 <<EOF\ninput\nEOF',
  'echo "x" | node C:/x/read-stdin.js',
  'cat data.json | python process.py',
  'cat file | jq -r ".a"',
  'pwsh -NoProfile -Command "Get-Date"',
  'pwsh -NoProfile -File C:/x/.tmp/script.ps1',
  'python C:/x/script.py --flag',
  'python3 -m pytest tests/',
  'python -m pip install -c constraints.txt -r requirements.txt',
  'python -m pytest -c pytest.ini tests/',
  'python -mcalendar',
  'python manage.py test -c',
  'python -Wc script.py',
  'python -m pytest \\\n' + '    tests/a.py \\\n'.repeat(10),
  'deno run app.ts',
  'printf "%s\\n" "node -e is banned"',
  'rg --crlf -n "node -e" docs/',
  'here <<< "string"',
  'cat <<<"node -e"',
  'jq -r ".a" <<< "$json"\npython process.py',
  'node < script.js',
  'if [ -f x ]; then node build.js; fi',
  'for f in *.json; do node check.js "$f"; done',
  'timeout 30 node server.js',
  'find . -name "*.js" | xargs node lint.js',
  'deno --version',
  'echo "a\\"b" | node handle.js',
  'echo "version: $(node version.js)"',
  'v="$(node C:/x/cli.js --json)"; echo "$v"',
  'echo "$(date)"; node build.js',
  'echo $((1<<2))\nnode build.js',
  'function f { node build.js; }',
  'f() { node build.js; }',
  'stdbuf -oL node server.js',
  'echo x | node $(git rev-parse --show-toplevel)/x.js',
  'echo x | node "$(git rev-parse --show-toplevel)/x.js"',
  'cat req.json | python $(git rev-parse --show-toplevel)/tools/t.py',
  'cat x | node $(pwd)',
];

let failures = 0;
const run = command => {
  const started = Date.now();
  const result = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return { ...result, ms: Date.now() - started };
};
for (const command of blocked) {
  const result = run(command);
  if (result.status !== 2 || !result.stderr.includes('Blocked by no-inline-scripts hook')) { failures++; console.log('NOT BLOCKED:', JSON.stringify(command), 'exit', result.status); }
  if (result.ms > MAX_MS) { failures++; console.log('SLOW:', JSON.stringify(command), result.ms, 'ms'); }
}
for (const command of allowed) {
  const result = run(command);
  if (result.status !== 0) { failures++; console.log('WRONGLY BLOCKED:', JSON.stringify(command), 'exit', result.status, result.stderr.trim().split('\n')[0]); }
  if (result.ms > MAX_MS) { failures++; console.log('SLOW:', JSON.stringify(command), result.ms, 'ms'); }
}
const envelopes = [
  ['non-Bash tool', JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'node -e' } })],
  ['malformed JSON', 'not json'],
  ['empty stdin', ''],
  ['missing tool_input', JSON.stringify({ tool_name: 'Bash' })],
  ['non-string command', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 42 } })],
];
for (const [name, input] of envelopes) {
  const result = spawnSync(process.execPath, [hook], { input, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.status !== 0) { failures++; console.log('ENVELOPE NOT PASSED THROUGH:', name, 'exit', result.status); }
}
console.log(`${blocked.length} blocked, ${allowed.length} allowed, ${envelopes.length} envelope cases; failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
