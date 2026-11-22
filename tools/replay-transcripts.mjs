// Replays the calls mine-transcripts.mjs collected through the PreToolUse hooks in this checkout and writes a Markdown
// report per hook: refusals the hooks still make, refusals they no longer make, and commands they newly refuse. Use it
// after a parsing change to see real commands it starts or stops refusing; the report holds your own commands, so write
// it under the git-ignored .tmp/ folder.
// Usage: node tools/replay-transcripts.mjs <corpus.jsonl> <report.md>
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = basename(process.argv[1], '.mjs');
const [corpusFile, reportFile] = process.argv.slice(2);
if (!corpusFile || !reportFile) {
  console.error(`usage: node tools/${self}.mjs <corpus.jsonl> <report.md>`);
  process.exit(1);
}
const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
// A command runs through a hook only when it names something that hook inspects, or the hook refused it before.
const HOOKS = {
  'no-cd-chains': /\b(?:cd|pushd|chdir|set-location|sl|push-location)\b/i,
  'no-inline-scripts': /\b(?:node|python3?|py|pwsh|powershell|bash|sh|zsh|deno|ruby|perl|php|bun)\b/i,
  'no-sed-in-place': /\bg?sed\b/i,
};
const CONCURRENCY = 12;
// The session's own switches would turn hooks off, so they stay out of the replay, as in the self-tests.
const { CLAUDE_NO_CD_CHAINS: _cd, CLAUDE_NO_SED_IN_PLACE: _sed, ...env } = process.env;

const calls = readFileSync(corpusFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const distinct = new Map();
for (const call of calls) {
  const key = JSON.stringify([call.tool, call.command]);
  const entry = distinct.get(key) ?? { tool: call.tool, command: call.command, count: 0, refusedBy: new Set(), projects: new Set(), now: {} };
  entry.count++;
  if (call.refusedBy) entry.refusedBy.add(call.refusedBy);
  entry.projects.add(call.project);
  distinct.set(key, entry);
}

const run = (hook, entry) => new Promise(resolve => {
  const child = spawn(process.execPath, [join(scripts, `${hook}.mjs`)], { env, windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('close', status => resolve({ status, reason: stderr.split('\n')[0] }));
  child.stdin.end(JSON.stringify({ tool_name: entry.tool, tool_input: { command: entry.command } }));
});

const jobs = [];
for (const entry of distinct.values()) {
  for (const [hook, filter] of Object.entries(HOOKS)) if (filter.test(entry.command) || entry.refusedBy.has(hook)) jobs.push([hook, entry]);
}
let next = 0;
const worker = async () => {
  while (next < jobs.length) {
    const [hook, entry] = jobs[next++];
    const result = await run(hook, entry);
    entry.now[hook] = result.status === 2 ? result.reason : null;
  }
};
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const show = entry => `- \`${entry.tool}\` x${entry.count} (${[...entry.projects].slice(0, 3).join(', ')}): ${JSON.stringify(entry.command.slice(0, 400))}`;
const lines = ['# Replay report', '', `${calls.length} calls, ${distinct.size} distinct, ${jobs.length} hook runs.`, ''];
const summary = [];
for (const hook of Object.keys(HOOKS)) {
  const all = [...distinct.values()];
  const kept = all.filter(entry => entry.refusedBy.has(hook) && entry.now[hook]);
  const lost = all.filter(entry => entry.refusedBy.has(hook) && entry.now[hook] === null);
  const added = all.filter(entry => !entry.refusedBy.has(hook) && entry.now[hook]);
  const counts = `still refused ${kept.length}, no longer refused ${lost.length}, newly refused ${added.length}`;
  summary.push(`${hook}: ${counts}`);
  lines.push(`## ${hook}`, '', `${counts}.`, '');
  lines.push('### No longer refused', '', ...lost.map(show), '');
  lines.push('### Newly refused', '', ...added.map(show), '');
  lines.push('### Still refused', '', ...kept.map(show), '');
}
writeFileSync(reportFile, `${lines.join('\n')}\n`);
console.log(lines[2]);
for (const line of summary) console.log(line);
