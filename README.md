# Agent Hooks

Claude Code hooks for disciplined agent sessions, packaged as a plugin so they register themselves and update automatically. Two hooks ship: `no-inline-scripts` refuses inline interpreter bodies in Bash and PowerShell calls, and `context-warn` warns as session context usage crosses 50% and each 10% band above.

## Install

The plugin is published through the `astenlund` marketplace:

```
claude plugin marketplace add astenlund/nightshift
claude plugin install agent-hooks@astenlund
```

Restart Claude Code after installing. With `autoUpdate` enabled on the marketplace, later releases are picked up at the next startup. To verify that `no-inline-scripts` is live, ask for a Bash call such as `node -e "1"` and expect it to be refused with the hook's message; `context-warn` shows itself the first time a session passes half its window.

## no-inline-scripts

A `PreToolUse` hook on the Bash and PowerShell tools that refuses inline interpreter bodies, so script text never passes through shell quoting layers where it gets mangled silently. The command is split into pipeline segments and shell words in the tool's dialect (bash escapes with a backslash and substitutes in backticks; PowerShell escapes with a backtick, a backslash is a path separator, and a `{ scriptblock }` nests commands, so a `ForEach-Object { ... }` or `try { ... }` body is inspected too), and each segment's command word is classified, so the check is linear in the command length and sees the same command word the shell would, whether written as `node`, `node.exe`, a full path, or behind an environment assignment, a call operator (`&`), a shell keyword (`if`, `for ... do`, `{`, `!`) or a wrapper such as `timeout 30`, `xargs`, `sudo -u` or `env -i`.

Blocked in any segment, including `||` fallbacks, `$(...)` substitutions and loop bodies:

- `node`, `nodejs` and `bun` with `-e`, `-p`, `-pe`, `--eval` or `--print`
- `deno eval` and `deno --eval`
- `python`, `python3`, `python3.x` and `py` with a `-c` option in any spelling (`-Bc`, `-c'body'`, `-cbody`)
- `bash`, `sh` and `zsh` with a `-c` body (in any short-option cluster, such as `-lc`) of more than one statement or over 200 characters
- `pwsh` and `powershell` with a `-Command` or `-CommandWithArgs` body (`-c`, `-cwa`, or any prefix pwsh accepts; a quoted string or a `{ scriptblock }`) of more than one statement or over 200 characters, or with `-EncodedCommand`
- any of those interpreters reading its program from stdin through a pipe, a heredoc, a herestring or a bare `-`

Statements in a body are counted as the interpreter that receives it reads them: unquoted semicolons and newlines separate them, a single `&` too in a bash body, and a separator inside a string literal does not count, with a backslash escaping in a bash body and a backtick in a pwsh body. A pipeline or an `&&` chain is one statement. A one-statement `pwsh -Command` or `bash -c` argument passes, because a single short command handed to a shell is not a script body. The statement and length limits are a mechanical floor, not approval of everything that fits under them. A segment with a script argument passes, including a plain-data heredoc or pipe feeding that script, so `python read.py <<EOF`, `cat data | node handle.js`, `python -m pytest -c pytest.ini`, `node server.js -p 3000`, `pwsh -File script.ps1`, `grep -e` and `sed -e` are all fine. On the PowerShell tool the command text is itself a script, so only the interpreters it calls are inspected. On a match the hook exits 2 with a reason that tells the model to write the body to a file and run it by path. Fail-open: malformed input or an envelope from any other tool exits 0.

Accepted cost: one-expression uses of `node -e`, `node -p` and `python -c`, such as a JSON field pick, are refused like any other inline body; use jq or a saved script. Text that merely mentions an inline shape, such as a commit message or an echoed string containing `node -e`, passes because the classifier looks at command words, not at quoted text.

## context-warn

A `UserPromptSubmit` hook that warns when session context usage crosses 50% of the model window, then again at each higher 10% band. Reasoning quality tends to degrade past the halfway mark; the warning nudges toward `/compact` or a fresh session at a natural boundary.

It reads the tail of the session transcript (the path arrives on stdin), takes the latest assistant usage record, and computes context occupancy as `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Warned bands are deduplicated per session in a temp state file; compaction lowers the state so a re-crossing warns again. Fail-silent: any error exits 0 with no output, so the hook can never degrade a session.

The window defaults to 1M tokens. On a machine that runs 200k-window sessions, set the override in the `env` block of `~/.claude/settings.json`, which Claude Code passes to hook processes:

```json
"env": {
  "CLAUDE_CTX_WARN_WINDOW": "200000"
}
```

Any finite positive number works.

## Development

Node 22 or later, built-in modules only. Run both self-tests after any edit:

```
node scripts/no-inline-scripts.test.mjs
node scripts/context-warn.test.mjs
```

The first spawns the hook by path with Bash and PowerShell tool envelopes for every blocked and allowed shape, checks the exit code and stderr marker, and fails any case slower than two seconds. The second writes transcripts with usage records into an isolated temp directory and checks when the warning fires, including band deduplication, compaction and the window override. CI runs both on Windows. Every release that changes `hooks` or `scripts` needs a version increase in `.claude-plugin/plugin.json`, since the marketplace update check compares that field.
