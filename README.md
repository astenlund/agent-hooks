# Agent Hooks

Claude Code hooks for disciplined agent sessions, packaged as a plugin so they register themselves and update automatically. Two hooks ship: `no-inline-scripts` refuses inline interpreter bodies in Bash calls, and `context-warn` warns as session context usage crosses 50% and each 10% band above.

## Install

The plugin is published through the `astenlund` marketplace:

```
claude plugin marketplace add astenlund/nightshift
claude plugin install agent-hooks@astenlund
```

Restart Claude Code after installing. With `autoUpdate` enabled on the marketplace, later releases are picked up at the next startup. To verify that `no-inline-scripts` is live, ask for a Bash call such as `node -e "1"` and expect it to be refused with the hook's message; `context-warn` shows itself the first time a session passes half its window.

## no-inline-scripts

A `PreToolUse` hook on the Bash tool that refuses inline interpreter bodies, so script text never passes through shell quoting layers where it gets mangled silently. The command is split into pipeline segments and shell words, and each segment's command word is classified, so the check is linear in the command length and sees the same command word the shell would, whether written as `node`, `node.exe`, a full path, or behind an environment assignment, a shell keyword (`if`, `for ... do`, `{`, `!`) or a wrapper such as `timeout 30`, `xargs`, `sudo -u` or `env -i`.

Blocked in any segment, including `||` fallbacks, `$(...)` substitutions and loop bodies:

- `node`, `nodejs` and `bun` with `-e`, `-p`, `-pe`, `--eval` or `--print`
- `deno eval` and `deno --eval`
- `python`, `python3`, `python3.x` and `py` with a `-c` option in any spelling (`-Bc`, `-c'body'`, `-cbody`)
- any of those interpreters, or `bash`, `sh`, `zsh`, `pwsh` and `powershell`, reading its program from stdin through a pipe, a heredoc, a herestring or a bare `-`

A segment with a script argument passes, including a plain-data heredoc or pipe feeding that script, so `python read.py <<EOF`, `cat data | node handle.js`, `python -m pytest -c pytest.ini`, `node server.js -p 3000`, `grep -e` and `sed -e` are all fine. On a match the hook exits 2 with a reason that tells the model to write the body to a file and run it by path. Fail-open: malformed input or a non-Bash envelope exits 0.

Accepted cost: one-expression uses such as a JSON field pick are refused like any other inline body; use jq or a saved script. Text that merely mentions an inline shape, such as a commit message or an echoed string containing `node -e`, passes because the classifier looks at command words, not at quoted text. `pwsh -Command` and `bash -c` are deliberately not blocked.

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

The first spawns the hook by path with Bash tool envelopes for every blocked and allowed shape, checks the exit code and stderr marker, and fails any case slower than two seconds. The second writes transcripts with usage records into an isolated temp directory and checks when the warning fires, including band deduplication, compaction and the window override. CI runs both on Windows. Every release that changes `hooks` or `scripts` needs a version increase in `.claude-plugin/plugin.json`, since the marketplace update check compares that field.
