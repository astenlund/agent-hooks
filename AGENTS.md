# agent-hooks

## What this is

A Claude Code plugin (`agent-hooks`, published through the `astenlund` marketplace) shipping four hooks: `no-inline-scripts`, `no-cd-chains` and `no-sed-in-place` (PreToolUse on the Bash and PowerShell tools) and `context-warn` (UserPromptSubmit). `README.md` is the authoritative description of each hook's blocked and allowed shapes, switches and failure behavior; keep it in step with any behavior change.

## Commands

Node 22 or later, built-in modules only; there is no `package.json`, build step or linter. Run every self-test from the repository root after any edit (CI runs the same four on Windows, each as its own step in `.github/workflows/ci.yml`, so a new hook's test needs a step there; `no-sed-in-place.test.mjs` also runs on Linux):

```
node scripts/no-inline-scripts.test.mjs
node scripts/no-cd-chains.test.mjs
node scripts/no-sed-in-place.test.mjs
node scripts/context-warn.test.mjs
```

The three PreToolUse tests are table-driven (`blocked` and `allowed` arrays, where an entry is a command string for the Bash tool or a `[command, 'PowerShell']` pair, plus `envelopes` and, in `no-cd-chains` and `no-sed-in-place`, `switches`); `no-sed-in-place` only refuses on Windows, so its test expects every case to pass elsewhere; `context-warn.test.mjs` is a sequence of named `expect` scenarios. The PreToolUse tests fail any blocked or allowed case slower than two seconds, and none of the tests has a single-case filter. To probe one command, pipe a tool envelope into the hook directly from the Bash tool and read its exit code (2 = blocked, 0 = allowed):

```
echo '{"tool_name":"Bash","tool_input":{"command":"cd x && ls"}}' | env -u CLAUDE_NO_CD_CHAINS node scripts/no-cd-chains.mjs; echo $?
```

The `env -u` keeps the session's `CLAUDE_NO_CD_CHAINS` out of the probe, as the test does, since a value of `0` or `false` makes `no-cd-chains` allow everything.

These hooks are typically installed and active in the session working on them, so a command matching a blocked shape is refused for you too; put new shapes in the test tables rather than typing them as live commands.

## Architecture

- `hooks/hooks.json` registers each script as `node "${CLAUDE_PLUGIN_ROOT}/scripts/<hook>.mjs"`. The PreToolUse hooks read the tool envelope as JSON on stdin, block by exiting 2 with the reason on stderr, and fail open (malformed input or another tool's envelope exits 0). `context-warn` reads the UserPromptSubmit payload (`session_id`, `transcript_path`), never blocks, warns by printing a `{"systemMessage": ...}` JSON object on stdout, and fails silent (any error exits 0 with no output).
- `scripts/shell-segments.mjs` is the shared parser for the PreToolUse hooks. `segments(command, DIALECTS[tool])` splits a command into segments of shell words in the tool's dialect, cutting at unquoted pipes, `;`, `&&`, `||`, `&`, newlines and bare `( ... )` groups; a substitution (`$(...)` or backticks, inside double quotes too) or a PowerShell scriptblock, `@(...)` or argument group yields its own segments while the enclosing segment continues around it. The dialects differ in escaping: Bash uses a backslash; PowerShell uses a backtick and treats a backslash as a path separator. Backticks substitute only in Bash, and braces open scriptblocks only in PowerShell. Comments are skipped: a `#` that starts a word (in PowerShell also one right after a closing `)` or `}`) runs to the end of the line, or to the unescaped closing backtick inside a Bash backtick substitution, and PowerShell `<# ... #>` blocks are skipped too. Heredoc bodies are skipped up to their delimiter, taken after quote and backslash removal as Bash does, except that an unquoted body (no part of the delimiter quoted or escaped) is parsed in the `HEREDOC` quote state, like double-quoted text that nothing closes, so the substitutions Bash runs in it yield segments. A substitution's segments are emitted before the segment containing it. Each segment carries `scope` (its enclosing frame), `pipedIn` and `stdinFed`; each frame records `parent` and `owner`. `commandWords` strips keywords, assignments and wrappers (`env`, `sudo`, `timeout`, `xargs`, ...) to reach the real command word.
- `no-inline-scripts.mjs` classifies each segment's command word as an interpreter and counts statements in `-c`/`-Command` bodies the way the receiving interpreter reads them. `no-cd-chains.mjs` finds a directory-change segment anywhere in the command and refuses unless every other segment sits in a frame that segment's own words opened (its arguments), using the frame tree. `no-sed-in-place.mjs` checks every segment whose command word is `sed` or `gsed`, and every command list a `find` segment runs through `-exec`, `-execdir`, `-ok` or `-okdir`, for an in-place option outside binary mode, skipping the values of `-e`, `-f`, `-l` and `-V` and of `--expression`, `--file` and `--line-length`; it exits 0 off Windows.
- `context-warn.mjs` reads the transcript tail for the latest assistant usage record and deduplicates warned bands per session in a temp-dir state file; the window comes from `CLAUDE_CTX_WARN_WINDOW` (default 1M).

## Releasing

Every release that changes `hooks/` or `scripts/` needs a version bump in `.claude-plugin/plugin.json`: the marketplace update check compares that field, so without it installed copies never update.
