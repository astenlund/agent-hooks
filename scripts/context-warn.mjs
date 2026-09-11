// UserPromptSubmit hook: warn when session context usage crosses 50%,
// then again at each higher 10% band. Reads the last
// assistant usage record from the session transcript; context size is
// input + cache_read + cache_creation tokens of the latest turn. The
// window defaults to 1M and can be overridden through the
// CLAUDE_CTX_WARN_WINDOW environment variable (e.g. 200000), set in the
// env block of ~/.claude/settings.json. Warned bands are tracked per
// session in a temp state file and reset downward after compaction so
// a re-crossing warns again. Fail-silent: any error exits 0 with no
// output. Registered by the plugin's hooks/hooks.json; self-test:
// node scripts/context-warn.test.mjs
import { readFileSync, writeFileSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const transcript = input.transcript_path;
  const sessionId = String(input.session_id || '').replace(/[^a-zA-Z0-9-]/g, '') || 'unknown';
  if (!transcript) process.exit(0);

  const fd = openSync(transcript, 'r');
  const size = fstatSync(fd).size;
  const tailLen = Math.min(size, 262144);
  const buf = Buffer.alloc(tailLen);
  readSync(fd, buf, 0, tailLen, size - tailLen);
  closeSync(fd);

  const lines = buf.toString('utf8').split('\n');
  let usage = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue;
    try {
      const u = JSON.parse(lines[i])?.message?.usage;
      if (u && typeof u.input_tokens === 'number') {
        usage = u;
        break;
      }
    } catch {
      // Partial or foreign line; keep scanning backwards.
    }
  }
  if (!usage) process.exit(0);

  const context = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  // The transcript's model id carries no window marker (observed: plain
  // "claude-fable-5" in a 1M session), so the window is not derivable
  // from the transcript. Default to a 1M window; set
  // CLAUDE_CTX_WARN_WINDOW=200000 in the settings env block for 200k
  // sessions.
  const override = Number(process.env.CLAUDE_CTX_WARN_WINDOW);
  const window = Number.isFinite(override) && override > 0 ? override : 1000000;
  const pct = Math.round((context / window) * 100);
  const band = Math.floor(pct / 10) * 10;

  const stateFile = join(tmpdir(), `claude-ctx-warn-${sessionId}.json`);
  let warnedBand = 0;
  try {
    warnedBand = JSON.parse(readFileSync(stateFile, 'utf8')).band || 0;
  } catch {
    // First run for this session, or unreadable state; treat as none.
  }

  if (band < 50 || band < warnedBand) {
    // Below threshold, or context shrank (compaction): silently lower
    // the state so the next upward crossing warns again. Upward moves
    // below 50 are not persisted; they never affect warn decisions.
    if (warnedBand > band) writeFileSync(stateFile, JSON.stringify({ band }));
    process.exit(0);
  }
  if (band === warnedBand) process.exit(0);

  writeFileSync(stateFile, JSON.stringify({ band }));
  const windowLabel = window >= 1000000 ? `${Math.round(window / 100000) / 10}M` : `${Math.round(window / 1000)}k`;
  console.log(JSON.stringify({
    systemMessage: `Context at ~${pct}% of the ${windowLabel} window (crossed the ${band}% band). Reasoning quality may degrade; consider /compact or a fresh session at a natural boundary.`,
  }));
} catch {
  process.exit(0);
}
