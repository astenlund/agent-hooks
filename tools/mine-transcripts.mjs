// Streams every Claude Code transcript under a projects folder and writes one JSON line per Bash or PowerShell tool
// call: tool, command, project folder, timestamp, and the hook that refused it, if any (from the matching tool result).
// The output holds commands from your own sessions, so write it under the git-ignored .tmp/ folder.
// Usage: node tools/mine-transcripts.mjs <output.jsonl> [projects folder, default ~/.claude/projects]
import { createReadStream, createWriteStream, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

const self = basename(process.argv[1], '.mjs');
const [outputFile, root = join(homedir(), '.claude', 'projects')] = process.argv.slice(2);
if (!outputFile) {
  console.error(`usage: node tools/${self}.mjs <output.jsonl> [projects folder]`);
  process.exit(1);
}
// A real refusal is an errored result whose text opens with the host's PreToolUse hook error line; the marker text
// alone also appears in ordinary output (test runs, the hook's own source).
const MARKER = /^PreToolUse:\w+ hook error: [^\n]*?Blocked by (no-[a-z-]+) hook/;

const files = [];
const walk = dir => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith('.jsonl')) files.push(path);
  }
};
walk(root);

const output = createWriteStream(outputFile);
const text = content => (typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part?.text ?? '').join('\n') : '');
let calls = 0;
let refused = 0;
for (const file of files) {
  const project = file.slice(root.length + 1).split(/[\\/]/)[0];
  const pending = new Map();
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a truncated or partial transcript line carries no usable call
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'tool_use' && (part.name === 'Bash' || part.name === 'PowerShell') && typeof part.input?.command === 'string') {
        pending.set(part.id, { tool: part.name, command: part.input.command, project, ts: entry.timestamp ?? null, refusedBy: null });
      } else if (part?.type === 'tool_result' && pending.has(part.tool_use_id)) {
        const call = pending.get(part.tool_use_id);
        pending.delete(part.tool_use_id);
        call.refusedBy = part.is_error ? (MARKER.exec(text(part.content))?.[1] ?? null) : null;
        calls++;
        if (call.refusedBy) refused++;
        output.write(`${JSON.stringify(call)}\n`);
      }
    }
  }
  for (const call of pending.values()) {
    calls++;
    output.write(`${JSON.stringify(call)}\n`);
  }
}
output.end();
console.log(JSON.stringify({ files: files.length, calls, refused }));
