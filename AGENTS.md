# agent-hooks

## What this is

A Claude Code plugin (`agent-hooks`, published through the `astenlund` marketplace) shipping four hooks: `no-inline-scripts`, `no-cd-chains` and `no-sed-in-place` (PreToolUse on the Bash and PowerShell tools) and `context-warn` (UserPromptSubmit). `README.md` is the authoritative description of each hook's blocked and allowed shapes, switches and failure behavior; keep it in step with any behavior change. Its Threat model section decides what a hook should catch: forms models write by reflex, not deliberate evasion, without refusing ordinary commands. Quote that section in every review brief so findings are ranked by it, and answer a reported slip by adding the command to the hook's `encountered` table with the narrowest fix that catches it.

## Commands

Node 22 or later, built-in modules only; there is no `package.json`, build step or linter. Run every self-test from the repository root after any edit (CI runs the same four on Windows, each as its own step in `.github/workflows/ci.yml`, so a new hook's test needs a step there; `no-sed-in-place.test.mjs` also runs on Linux):

```
node scripts/no-inline-scripts.test.mjs
node scripts/no-cd-chains.test.mjs
node scripts/no-sed-in-place.test.mjs
node scripts/context-warn.test.mjs
```

The three PreToolUse tests are table-driven (`blocked`, `encountered` and `allowed` arrays, where `encountered` holds real commands from session transcripts, paths and identifiers generalized, and an entry is a command string for the Bash tool or a `[command, 'PowerShell']` pair, plus `envelopes` and, in `no-cd-chains` and `no-sed-in-place`, `switches`); `no-sed-in-place` only refuses on Windows, so its test expects every case to pass elsewhere; `context-warn.test.mjs` is a sequence of named `expect` scenarios. The PreToolUse tests fail any `blocked`, `encountered` or `allowed` case slower than two seconds, and none of the tests has a single-case filter. To probe one command, pipe a tool envelope into the hook directly from the Bash tool and read its exit code (2 = blocked, 0 = allowed):

```
echo '{"tool_name":"Bash","tool_input":{"command":"cd x && ls"}}' | env -u CLAUDE_NO_CD_CHAINS node scripts/no-cd-chains.mjs; echo $?
```

The `env -u` keeps the session's `CLAUDE_NO_CD_CHAINS` out of the probe, as the test does, since a value of `0` or `false` makes `no-cd-chains` allow everything.

After a parsing change, replay the local transcripts with `tools/mine-transcripts.mjs` and `tools/replay-transcripts.mjs`, as the README's Development section shows, and check the newly refused list for ordinary commands. Both tools write only to `.tmp/<run>/` through `tools/run-folder.mjs`, since their output holds the user's own commands; generalize any command copied from it into a test.

These hooks are typically installed and active in the session working on them, so a command matching a blocked shape is refused for you too; put new shapes in the test tables rather than typing them as live commands.

## Architecture

- `hooks/hooks.json` registers each script as `node "${CLAUDE_PLUGIN_ROOT}/scripts/<hook>.mjs"`. The PreToolUse hooks read the tool envelope as JSON on stdin, block by exiting 2 with the reason on stderr, and fail open (malformed input or another tool's envelope exits 0). `context-warn` reads the UserPromptSubmit payload (`session_id`, `transcript_path`), never blocks, warns by printing a `{"systemMessage": ...}` JSON object on stdout, and fails silent (any error exits 0 with no output).
- `scripts/shell-segments.mjs` is the shared parser for the PreToolUse hooks. `segments(command, DIALECTS[tool])` splits a command into segments of shell words in the tool's dialect, cutting at unquoted pipes, `;`, `&&`, `||`, `&`, newlines and bare `( ... )` groups; a substitution (`$(...)` or backticks, inside double quotes too) or a PowerShell scriptblock, `@(...)` or argument group yields its own segments while the enclosing segment continues around it. The dialects differ in escaping: Bash uses a backslash; PowerShell uses a backtick and treats a backslash as a path separator. Backticks substitute only in Bash, and braces open scriptblocks only in PowerShell. A substitution's segments are emitted before the segment containing it. Each segment carries `scope` (its enclosing frame), `pipedIn` and `stdinFed`; each frame records `parent` and `owner`. `commandWords` strips keywords, assignments and wrappers (`env`, `sudo`, `timeout`, `xargs`, ...) to reach the real command word.
- `no-inline-scripts.mjs` classifies each segment's command word as an interpreter and counts statements in `-c`/`-Command` bodies the way the receiving interpreter reads them. `no-cd-chains.mjs` finds a directory-change segment anywhere in the command and refuses unless every other segment sits in a frame that segment's own words opened (its arguments), using the frame tree. `no-sed-in-place.mjs` checks every segment whose command word is `sed` or `gsed`, and every command list a `find` segment runs through `-exec`, `-execdir`, `-ok` or `-okdir`, for an in-place option outside binary mode, skipping the values of `-e`, `-f`, `-l` and `-V` and of `--expression`, `--file` and `--line-length`; it exits 0 off Windows.
- `context-warn.mjs` reads the transcript tail for the latest assistant usage record and deduplicates warned bands per session in a temp-dir state file; the window comes from `CLAUDE_CTX_WARN_WINDOW` (default 1M).

## Releasing

Every release that changes `hooks/` or `scripts/` needs a version bump in `.claude-plugin/plugin.json`: the marketplace update check compares that field, so without it installed copies never update.

## Ideas

False refusals the shared parser can still produce, none of them seen in a replay of every Bash and PowerShell call in the local Claude Code transcripts (2026-11-22); fix one when a real command hits it:

- A `#` comment is not recognized, so a separator inside one cuts a segment, as in `git status # then; cd x`.
- A quoted PowerShell string at command position is read as a command word, as in a block that only yields `'cd'`.
- Text after PowerShell's stop-parsing token (`--%`) is parsed as commands.
- A Bash array literal is parsed as a group of commands, so an element named like a directory change, as in `cmd=(cd "$repo"); printf '%s\n' "${cmd[@]}"`, is read as one.
- A PowerShell hashtable literal is parsed as a scriptblock, so a key named like a directory change, as in `$aliases = @{ cd = 'Set-Location' }; $aliases.Keys`, is read as one.
