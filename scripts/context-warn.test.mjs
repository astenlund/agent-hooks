// Self-test for context-warn.mjs: writes a transcript with a usage record,
// runs the hook by path with a UserPromptSubmit envelope on stdin, and
// checks when it warns. The state file goes to an isolated temp directory
// through TEMP and TMP, and the window is set to 1000 tokens through
// CLAUDE_CTX_WARN_WINDOW so context sizes are easy to reason about. Run
// from the repository root:
//   node scripts/context-warn.test.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hook = join(dirname(fileURLToPath(import.meta.url)), 'context-warn.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'context-warn-test-'));
const transcript = join(scratch, 'transcript.jsonl');
const session = 'test-' + Date.now();
let failures = 0;

const run = (input, env = {}) => spawnSync(process.execPath, [hook], {
  input, encoding: 'utf8', windowsHide: true, timeout: 10000,
  env: { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch, CLAUDE_CTX_WARN_WINDOW: '1000', ...env },
});
const usageLine = (input, cacheRead = 0, cacheCreation = 0) => JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation, output_tokens: 5 } } });
const submit = (context, sessionId = session) => {
  // An older, larger usage record precedes the latest one so a hook that took the first match would misreport.
  writeFileSync(transcript, ['{"type":"user","message":{"content":"hi"}}', usageLine(context * 3, 0, 0), '{"type":"user","message":{"content":"again"}}', usageLine(context - 100, 60, 40), '{"type":"progress","note":"trailing line without usage"}'].join('\n') + '\n');
  return run(JSON.stringify({ session_id: sessionId, transcript_path: transcript }));
};
const expect = (name, result, { exit = 0, band = null } = {}) => {
  const message = result.stdout.trim() ? JSON.parse(result.stdout).systemMessage : null;
  const bandOk = band === null ? message === null : typeof message === 'string' && message.includes(`crossed the ${band}% band`);
  if (result.status !== exit || !bandOk) { failures++; console.log('FAIL', name, 'exit', result.status, 'stdout', JSON.stringify(result.stdout), 'stderr', result.stderr.trim()); }
};

try {
  expect('below threshold stays silent', submit(300));
  expect('crossing 50 warns once', submit(550), { band: 50 });
  expect('same band stays silent', submit(580));
  expect('next band warns again', submit(720), { band: 70 });
  expect('skipping a band reports the band reached', submit(960), { band: 90 });
  expect('compaction lowers the state silently', submit(200));
  expect('re-crossing after compaction warns again', submit(610), { band: 60 });
  expect('another session has its own state', submit(550, session + '-other'), { band: 50 });
  expect('window override is honored', run(JSON.stringify({ session_id: session + '-window', transcript_path: transcript }), { CLAUDE_CTX_WARN_WINDOW: '2000' }));
  const label = submit(550, session + '-label');
  if (!label.stdout.includes('of the 1k window')) { failures++; console.log('FAIL window label', JSON.stringify(label.stdout)); }
  expect('missing transcript path is silent', run(JSON.stringify({ session_id: session })));
  expect('unreadable transcript is silent', run(JSON.stringify({ session_id: session, transcript_path: join(scratch, 'missing.jsonl') })));
  expect('malformed input is silent', run('not json'));
  writeFileSync(transcript, '{"type":"user","message":{"content":"no usage yet"}}\n');
  expect('transcript without usage is silent', run(JSON.stringify({ session_id: session + '-nousage', transcript_path: transcript })));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`context-warn self-test failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
