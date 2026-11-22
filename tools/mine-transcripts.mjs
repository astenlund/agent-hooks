// Streams every Claude Code transcript under a projects folder and writes one JSON line per Bash or PowerShell tool
// call to .tmp/<run>/corpus.jsonl: tool, command, project folder, timestamp, and the hook that refused it, if any (from
// the matching tool result). The corpus holds commands from the user's own sessions, hence the git-ignored folder.
// Usage: node tools/mine-transcripts.mjs <run> [projects folder, default ~/.claude/projects]
import { createReadStream, createWriteStream, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { RunFolderError, runFolder } from './run-folder.mjs';

const self = basename(process.argv[1], '.mjs');
// A real refusal is an errored result whose text opens with the host's PreToolUse hook error line; the marker text
// alone also appears in ordinary output (test runs, the hook's own source).
const MARKER = /^PreToolUse:\w+ hook error: [^\n]*?Blocked by (no-[a-z-]+) hook/;

const text = content => (typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part?.text ?? '').join('\n') : '');

function transcripts(root) {
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.jsonl')) files.push(path);
    }
  };
  walk(root);

  return files;
}

async function mine(root, output) {
  const files = transcripts(root);
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
        // A call or result without an id cannot be paired, so it is left out rather than matched to the wrong one.
        if (part?.type === 'tool_use' && typeof part.id === 'string' && part.id !== '' && (part.name === 'Bash' || part.name === 'PowerShell') && typeof part.input?.command === 'string') {
          pending.set(part.id, { tool: part.name, command: part.input.command, project, ts: entry.timestamp ?? null, refusedBy: null });
        } else if (part?.type === 'tool_result' && typeof part.tool_use_id === 'string' && part.tool_use_id !== '' && pending.has(part.tool_use_id)) {
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

  return { files: files.length, calls, refused };
}

const [run, given = join(homedir(), '.claude', 'projects')] = process.argv.slice(2);
const root = resolve(given); // an absolute root, so each file's project folder is the first segment after it
let folder;
try {
  folder = runFolder(run, { create: true });
} catch (error) {
  if (!(error instanceof RunFolderError)) throw error;
  console.error(`${self}: ${error.message}\nusage: node tools/${self}.mjs <run> [projects folder]`);
  process.exit(1);
}
const output = createWriteStream(join(folder, 'corpus.jsonl'));
const summary = await mine(root, output);
await new Promise(resolve => output.end(resolve));
console.log(JSON.stringify({ ...summary, corpus: join(folder, 'corpus.jsonl') }));
