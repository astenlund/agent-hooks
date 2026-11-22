# Agent Hooks

Claude Code hooks for disciplined agent sessions, packaged as a plugin so they register themselves and, with the marketplace's `autoUpdate` enabled, update at startup. Four hooks ship: `no-inline-scripts` refuses inline interpreter bodies in Bash and PowerShell calls, `no-cd-chains` refuses a directory change combined with other commands, `no-sed-in-place` refuses an in-place `sed` edit in text mode on Windows, and `context-warn` warns as session context usage reaches 50% and each further 10% band, once for the band reached when usage jumps past several.

## Threat model

The `PreToolUse` hooks catch habits, not adversaries: they target the command forms models write by reflex, such as `cd dir && command`, `d=...; cd dir; command`, `node -e "..."` or `sed -i 's/a/b/' file`, and block them with a reason that steers the model to the better form. A bypass that needs an unusual spelling no model writes unprompted is out of scope, while refusing an ordinary command is a defect, so a parsing rule earns its place only when it catches a form models actually use without refusing commands they write innocently. Each hook's self-test keeps an `encountered` table of real commands taken from session transcripts that the hook must keep refusing; a reported slip is added there, and its fix is the narrowest change that catches it.

## Install

The plugin is published through the `astenlund` marketplace:

```
claude plugin marketplace add astenlund/nightshift
claude plugin install agent-hooks@astenlund
```

Restart Claude Code after installing. With `autoUpdate` enabled on the marketplace, later releases are picked up at the next startup. To verify that `no-inline-scripts` is live, ask for a Bash call such as `node -e "1"` and expect it to be refused with the hook's message; likewise `cd .. && ls` for `no-cd-chains` and, on Windows, `sed -i 's/a/b/' x.txt` for `no-sed-in-place`. `context-warn` shows itself the first time a session passes half its window.

## no-inline-scripts

A `PreToolUse` hook on the Bash and PowerShell tools that refuses inline interpreter bodies, so script text never passes through shell quoting layers where it gets mangled silently. The command is split into pipeline segments and shell words in the tool's dialect by the shared parser in `scripts/shell-segments.mjs` (bash escapes with a backslash and substitutes in backticks; PowerShell escapes with a backtick, a backslash is a path separator, and a `{ scriptblock }` nests commands, so a `ForEach-Object { ... }` or `try { ... }` body is inspected too), and each segment's command word is classified, so the check is linear in the command length for ordinary commands and sees the same command word the shell would, whether written as `node`, `node.exe`, a full path, or behind an environment assignment, a call operator (`&`), a shell keyword (`if`, `for ... do`, `{`, `!`) or a wrapper such as `timeout 30`, `xargs`, `sudo -u` or `env -i`.

Blocked in any segment, including `||` fallbacks, `$(...)` substitutions (except inside a PowerShell `@"` here-string, whose text the parser reads as data) and loop bodies:

- `node`, `nodejs` and `bun` with `-e`, `-p`, `-pe`, `-ep`, `--eval` or `--print`
- `deno eval` and `deno --eval`
- `python`, `python3`, `python3.x` and `py` with a `-c` option in any spelling (`-Bc`, `-c'body'`, `-cbody`)
- `bash`, `sh` and `zsh` with a `-c` body (in any short-option cluster, such as `-lc`) of more than one statement or over 200 characters
- `pwsh` and `powershell` with a `-Command` or `-CommandWithArgs` body (`-c`, `-cwa`, or any prefix pwsh accepts; a quoted string or a `{ scriptblock }`) of more than one statement or over 200 characters, or with `-EncodedCommand`
- any of those interpreters reading its program from stdin through a pipe, a heredoc, a herestring or a bare `-`

Statements in a body are counted close to how the interpreter that receives it reads them: unquoted, unescaped semicolons and newlines separate them, a single background `&` too in a bash body (not one in a redirection such as `2>&1`), and a separator inside a string literal does not count, with a backslash escaping in a bash body and a backtick in a pwsh body. A pipeline or an `&&` chain on one line is one statement; an unquoted, unescaped newline separates statements even after a `|` or `&&`, where the shell would continue the line. A one-statement `pwsh -Command` or `bash -c` argument within the 200-character limit passes, because a single short command handed to a shell is not a script body; that covers the text the child shell receives, while a substitution the calling shell runs first, as in `bash -c "echo $(node -p 1)"`, is inspected like any other segment. The statement and length limits are a mechanical floor, not approval of everything that fits under them. A segment with a script argument passes, including a plain-data heredoc or pipe feeding that script, so `python read.py <<EOF`, `cat data | node handle.js`, `python -m pytest -c pytest.ini`, `node server.js -p 3000`, `pwsh -File script.ps1`, `grep -e` and `sed -e` are all fine. On the PowerShell tool the command text is itself a script, so only the interpreters it calls are inspected. On a match the hook exits 2 with a reason that tells the model to write the body to a file and run it by path. Fail-open: malformed input or an envelope from any other tool exits 0.

Accepted cost: one-expression uses of `node -e`, `node -p` and `python -c`, such as a JSON field pick, are refused like any other inline body; use jq or a saved script. Text that merely mentions an inline shape, such as a commit message or an echoed string containing `node -e`, passes because the classifier looks at command words, not at quoted text.

## no-cd-chains

A `PreToolUse` hook on the Bash and PowerShell tools that refuses a command that contains a directory change (`cd`, `pushd`, `chdir`, `Set-Location`, `sl` or `Push-Location`, in any letter case) alongside anything else, wherever it sits, as in `cd C:/Git/x && npm test`, `Set-Location C:\Git\x; dotnet test` or `git status && cd C:/Git/x`. A directory change combined with other commands can leave the session's working directory somewhere the agent did not intend, so later relative paths resolve against the wrong place. Only a bare directory change, the whole command on its own, passes, because that is how a drifted working directory gets restored. On a match the hook exits 2 with a reason that tells the model to pass full paths to the command, or to use `git -C <dir>` for Git.

The command is split by the same parser `no-inline-scripts` uses, so the command word is found behind wrappers (`command`, `builtin`, `env`, `sudo` and the rest; `command -v` and `command -V` only look a name up, so `command -v cd; ls` passes), keywords (`if`, `{`) and assignments, and every separator that joins another command counts: `&&`, `||`, `;`, `&`, `|`, `|&` and a newline (a trailing one joins nothing, so `cd C:/Git/x;` passes, and so does `cd C:/Git/x &`, though a directory change sent to the background leaves the session's working directory as it was). A directory change is found inside groups, substitutions, blocks and compound commands too, including a substitution inside double quotes, a PowerShell `@(...)` array subexpression and a block invoked by `&` or `.`, so `(cd C:/Git/x && make)`, `x=$(cd C:/Git/x && pwd)`, `if [ -d x ]; then cd x; fi` and `& { Set-Location C:\Git\x }` are all refused, even where a Bash subshell would confine the directory change. It is not found in the text another shell receives as its body, such as a single-quoted `bash -c` or `pwsh -Command` string (a double-quoted body's `$(...)` runs in the calling shell first, so `bash -c "echo $(cd x; pwd)"` is refused, and a `{ scriptblock }` passed to `-Command` on the PowerShell tool is inspected like any other block), nor inside a PowerShell here-string, opened by `@'` or `@"` ending a line, at the start of a word or right after a word ending in `=`, as in an assignment or a hashtable key (`$text=@'`, `$text +=@'`, `@{ Notes=@'`), and closed by `'@` or `"@` starting a later one, whose text is data; a `$(...)` subexpression in an `@"` here-string is not inspected either. A substitution or argument group in the directory argument, as in `cd "$(git rev-parse --show-toplevel)"` or `Set-Location (Join-Path $root src) -PassThru`, is part of the directory change and passes, even when it changes directory itself. Fail-open: malformed input or an envelope from any other tool exits 0.

The hook is on by default, since chaining a directory change into the command is a common failure mode across models. Where `cd dir && command` is a deliberate habit, turn it off in the `env` block of `~/.claude/settings.json`, which Claude Code passes to hook processes:

```json
"env": {
  "CLAUDE_NO_CD_CHAINS": "0"
}
```

The values `0` and `false` (in any letter case, ignoring surrounding whitespace) turn it off; anything else, or no value, leaves it on.

## no-sed-in-place

A `PreToolUse` hook on the Bash and PowerShell tools that, on Windows, refuses a `sed` (or `gsed`) command that edits a file in place in text mode. Git Bash `sed` reads in text mode: it drops each line's trailing CR and does not write it back, so `sed -i` rewrites a CRLF file to LF even when no substitution fires, and a file whose committed copy is CRLF then shows every line as changed. On other platforms the hook allows everything.

In place means `-i` as an option in a short-option cluster (`-i`, `-i.bak`, `-ni`, `-Ei`; in `-ib` the `b` is the backup suffix, not binary mode) or `--in-place`, with or without `=SUFFIX` and as any unambiguous prefix such as `--in`. A value taken by `-e`, `-f`, `-l` or the undocumented `-V`, or by `--expression`, `--file` or `--line-length`, attached or as the next word, is not an option, so `sed -ei file` and `sed -e -i file` pass, and nothing after `--` counts. Binary mode (`-b` or `--binary`) keeps every CR, so `sed -b -i` passes; a pattern anchored on `$` must then match the CR explicitly. The command is split by the same parser the other two `PreToolUse` hooks use, so `sed` is found in every segment, behind wrappers such as `xargs` and `env`, keywords and assignments, and in the command lists that `find` runs through `-exec`, `-execdir`, `-ok` and `-okdir`, but not inside another shell's quoted body, such as a quoted `bash -c` or `pwsh -Command` string (a `{ scriptblock }` passed to `-Command` on the PowerShell tool is inspected like any other block), nor where it is only an argument of some other command, as in `watch sed -i ...`. On a match the hook exits 2 with a reason that tells the model to make the edit with the Edit tool, or, when the edit involves an escape sequence the Edit tool would decode, with a byte-level script run by path that builds each backslash from its code point. Fail-open: malformed input or an envelope from any other tool exits 0.

The hook is on by default, since the Bash tool runs Git Bash on Windows. Where Git Bash's `sed` is not the one your Bash and PowerShell calls run, turn the hook off in the `env` block of `~/.claude/settings.json`, which Claude Code passes to hook processes:

```json
"env": {
  "CLAUDE_NO_SED_IN_PLACE": "0"
}
```

The values `0` and `false` (in any letter case, ignoring surrounding whitespace) turn it off; anything else, or no value, leaves it on.

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

Node 22 or later, built-in modules only. Run every self-test after any edit:

```
node scripts/no-inline-scripts.test.mjs
node scripts/no-cd-chains.test.mjs
node scripts/no-sed-in-place.test.mjs
node scripts/context-warn.test.mjs
```

The first three spawn their hook by path with Bash and PowerShell tool envelopes for every blocked, encountered and allowed shape, check the exit code (and, for blocked and encountered shapes, the stderr marker wherever a refusal is expected), and fail any case in those tables slower than two seconds; the `no-cd-chains` and `no-sed-in-place` tests also check that their switch turns the hook off, and the `no-sed-in-place` test expects every case to pass off Windows. The last writes transcripts with usage records into an isolated temp directory and checks when the warning fires, including band deduplication, compaction and the window override. CI runs all four on Windows, and the `no-sed-in-place` test on Linux as well. Every release that changes `hooks` or `scripts` needs a version increase in `.claude-plugin/plugin.json`, since the marketplace update check compares that field.

To check a parsing change against real use, replay your own Claude Code history through the hooks in the checkout. Both tools take a run name (lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit and not ending in `.`, so that no two names share a folder on Windows) and keep their files in `.tmp/<run>/`, since the output holds commands from your sessions and `.tmp/` is git-ignored: the miner creates the folder and its corpus, and the replay reads the corpus mined under the same name. Give each run its own name:

```
node tools/mine-transcripts.mjs replay-1
node tools/replay-transcripts.mjs replay-1
```

The first collects every Bash and PowerShell call from the transcripts under `~/.claude/projects` (or a folder given as a second argument) into `corpus.jsonl`, with the hook that refused it, if any. The second runs each distinct command through every hook whose command words it mentions (the directory-change commands, the interpreters `no-inline-scripts` classifies, or `sed`), and through any hook that refused it before, and writes `report.md`: per hook, the past refusals still made, those no longer made, the commands newly refused, and any command the hook failed on. Both tools skip records they cannot read, such as a transcript line that is not valid JSON, a call or result without an id, or a corpus line an interrupted mining run left partly written, and skipped records do not count toward the totals. The report groups calls by tool and exact command text, so a command counts as a past refusal when any of its occurrences was refused, and a call whose result the transcript never recorded counts as not refused before; each command is shown cut to 400 characters, with the full text in `corpus.jsonl`. A newly refused command is either a form the hook now catches or an ordinary command it wrongly refuses. The replay runs with the hooks' switches cleared and on the current platform, so a category can also shift without any code change: calls made before a hook was installed, or while its switch had it off, show up as newly refused, and a `sed` refusal recorded on Windows shows up as no longer refused when replayed elsewhere. A real refusal worth keeping goes into the hook's `encountered` table, with its paths and identifiers generalized.
