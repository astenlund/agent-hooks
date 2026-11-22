// Replays the calls mine-transcripts.mjs collected in .tmp/<run>/corpus.jsonl through the PreToolUse hooks in this
// checkout and writes .tmp/<run>/report.md: per hook, refusals still made, refusals no longer made, commands newly
// refused, and commands the hook failed on. Use it after a parsing change to see real commands it starts or stops
// refusing; the report holds the user's own commands, hence the git-ignored folder.
// Usage: node tools/replay-transcripts.mjs <run>
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunFolderError, runFolder } from './run-folder.mjs';

const self = basename(process.argv[1], '.mjs');
const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
// Only a command naming something a hook inspects runs through it (or one it refused before), which keeps the replay
// fast; each pattern names every command word its hook classifies, as listed at the top of the hook's script.
const HOOKS = {
  'no-cd-chains': /\b(?:cd|pushd|chdir|set-location|sl|push-location)\b/i,
  'no-inline-scripts': /\b(?:node|nodejs|bun|deno|python(?:3(?:\.\d+)?)?|py|bash|sh|zsh|pwsh|powershell)\b/i,
  'no-sed-in-place': /\bg?sed\b/i,
};
const CONCURRENCY = 12;
// The session's own switches would turn hooks off, so they stay out of the replay, as in the self-tests.
const { CLAUDE_NO_CD_CHAINS: _cd, CLAUDE_NO_SED_IN_PLACE: _sed, ...env } = process.env;

function distinctCalls(corpusFile) {
  const distinct = new Map();
  let total = 0;
  for (const line of readFileSync(corpusFile, 'utf8').split('\n')) {
    if (line === '') continue;
    const call = JSON.parse(line);
    total++;
    const key = JSON.stringify([call.tool, call.command]);
    const entry = distinct.get(key) ?? { tool: call.tool, command: call.command, count: 0, refusedBy: new Set(), projects: new Set(), now: {} };
    entry.count++;
    if (call.refusedBy) entry.refusedBy.add(call.refusedBy);
    entry.projects.add(call.project);
    distinct.set(key, entry);
  }

  return { total, distinct };
}

// A hook's verdict on one call: 'refused' (exit 2), 'allowed' (exit 0), or 'failed' with its first stderr line.
const verdict = (hook, entry) => new Promise(resolve => {
  const child = spawn(process.execPath, [join(scripts, `${hook}.mjs`)], { env, windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => resolve({ kind: 'failed', reason: error.message }));
  child.on('close', status => resolve(status === 2 ? { kind: 'refused' } : status === 0 ? { kind: 'allowed' } : { kind: 'failed', reason: `exit ${status}: ${stderr.split('\n')[0]}` }));
  child.stdin.end(JSON.stringify({ tool_name: entry.tool, tool_input: { command: entry.command } }));
});

async function replay(distinct) {
  const jobs = [];
  for (const entry of distinct.values()) {
    for (const [hook, filter] of Object.entries(HOOKS)) if (filter.test(entry.command) || entry.refusedBy.has(hook)) jobs.push([hook, entry]);
  }
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const [hook, entry] = jobs[next++];
      entry.now[hook] = await verdict(hook, entry);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  return jobs.length;
}

function report(total, distinct, runs) {
  const show = entry => `- \`${entry.tool}\` x${entry.count} (${[...entry.projects].slice(0, 3).join(', ')}): ${JSON.stringify(entry.command.slice(0, 400))}`;
  const lines = ['# Replay report', '', `${total} calls, ${distinct.size} distinct, ${runs} hook runs.`, ''];
  const summary = [];
  const all = [...distinct.values()];
  for (const hook of Object.keys(HOOKS)) {
    const kind = entry => entry.now[hook]?.kind;
    const kept = all.filter(entry => entry.refusedBy.has(hook) && kind(entry) === 'refused');
    const lost = all.filter(entry => entry.refusedBy.has(hook) && kind(entry) === 'allowed');
    const added = all.filter(entry => !entry.refusedBy.has(hook) && kind(entry) === 'refused');
    const failed = all.filter(entry => kind(entry) === 'failed');
    const counts = `still refused ${kept.length}, no longer refused ${lost.length}, newly refused ${added.length}, hook failed ${failed.length}`;
    summary.push(`${hook}: ${counts}`);
    lines.push(`## ${hook}`, '', `${counts}.`, '');
    lines.push('### Hook failed', '', ...failed.map(entry => `${show(entry)} -- ${entry.now[hook].reason}`), '');
    lines.push('### No longer refused', '', ...lost.map(show), '');
    lines.push('### Newly refused', '', ...added.map(show), '');
    lines.push('### Still refused', '', ...kept.map(show), '');
  }

  return { text: `${lines.join('\n')}\n`, summary: [lines[2], ...summary] };
}

let folder;
try {
  folder = runFolder(process.argv[2]);
} catch (error) {
  if (!(error instanceof RunFolderError)) throw error;
  console.error(`${self}: ${error.message}\nusage: node tools/${self}.mjs <run>`);
  process.exit(1);
}
const { total, distinct } = distinctCalls(join(folder, 'corpus.jsonl'));
const runs = await replay(distinct);
const { text, summary } = report(total, distinct, runs);
writeFileSync(join(folder, 'report.md'), text);
for (const line of summary) console.log(line);
console.log(`report: ${join(folder, 'report.md')}`);
