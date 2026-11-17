# devbox

`devbox` is one command-line tool for machines that run [T3 Code](https://t3.codes) coding agents. It works the same on any Linux machine or Mac, whoever hosts it. Anything that differs between machines is a flag, not a folder named after a provider.

Today it has one command, `devbox migrate`, which maintains T3 Code's local state. Setting up a machine, linking it to T3, and backing up agent memory move into `devbox` next. Until then the shell scripts below still do that work.

`devbox` is TypeScript on [Bun](https://bun.sh) and [Effect](https://effect.website).

```sh
bun install
bun src/cli.ts --help
bun run build        # dist/devbox, a single binary
```

## Maintain T3 Code's state

`devbox migrate` edits T3 Code's database, `~/.t3/userdata/statev2.sqlite`, for the jobs the app has no screen for. It moves threads between projects, points a project at a renamed folder, and checks the database.

```sh
devbox migrate doctor
devbox migrate move-threads --to alpha --from beta --from gamma
devbox migrate move-threads --to alpha --from beta --apply
devbox migrate rename-root --project alpha --to ~/Projects/alpha --apply
```

| Command                                                           | What it changes                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doctor [--json] [--check]`                                       | Nothing. It reports whether T3 Code is running, the schema, the event log, each project with its thread count and whether its root exists, mismatches between a thread's column and its payload, session folders missing on disk, and Claude memory left under a symlinked spelling of a project's path. `--check` adds `PRAGMA quick_check`, which reads the whole file. |
| `move-threads --to <project> --from <project>... [--thread <id>]` | The project of each thread, in its column and in its payload. Scheduled tasks on the source projects stay where they are, with a warning.                                                                                                                                                                                                                                 |
| `rename-root --project <project> --to <path>`                     | The project's workspace root, and the folder of every provider session at or under the old root. With `--apply` it also copies the root's Claude transcripts and memory.                                                                                                                                                                                                  |

Name a project by its id or its title. A title that two live projects share is an error that lists both ids.

Every command takes `--db <path>` to work on a copy instead of the live database, and `--claude-home <path>` to say where Claude keeps the files of a provider instance that has no `homePath`.

### What every write does

- A command is a dry run unless you pass `--apply`. With `--apply` it asks `(y/N)` first. `--yes` skips the question. Without a terminal, `--apply` needs `--yes`.
- A write on the live database stops while T3 Code runs. It finds T3 Code through `server-runtime.json`, then through the process list on Linux and macOS. Dry runs and `doctor` open the database read-only, so they are safe while T3 Code runs.
- It checks that the tables and columns it touches exist and that `orchestration_v2_events` is empty. Once T3 Code keeps an event log, edits to its projections stop lasting.
- It backs up the database first with `VACUUM INTO`, to `~/.t3/backups/statev2-<stamp>.sqlite` or to `$T3_BACKUP_DIR`.
- It writes in one transaction. Then it checks the row counts and that `PRAGMA quick_check` reads the same as before. On a mismatch it prints the command that restores the backup.

### Claude transcripts and memory

Claude Code keeps them in `<home>/projects/<slug>`. The slug is the resolved folder with every character that is not a letter or digit turned into `-`. When a root moves, the files stay under the old slug, so `rename-root --apply` copies them to the new one.

- The Claude homes come from `$T3_HOME/userdata/settings.json`, one for each provider instance with the `claudeAgent` driver. An instance without a `homePath` uses `~/.claude`, or `--claude-home` when you pass it. `doctor` warns when `CLAUDE_CONFIG_DIR` points somewhere else.
- Files never move from one home to another. The root and every Claude session folder under it are copied. Sessions of other agents are not.
- Slugs come from the real path on this machine, so a symlinked parent gives the slug Claude writes.
- The copy is additive. It never changes or deletes a source file. It skips a file that is already there and the same. It never overwrites a file that differs, and lists it as a conflict at the end. It skips symlinks and counts them.
- The copy runs after the question and before the database transaction. If the copy fails, the database stays as it was, and running the command again finishes the job.
- `--db` on a copy is a rehearsal, so no files are copied and a note says so. A `--db` path that names the live database is not a copy.

### Environment

`T3_HOME` replaces `~/.t3` for the live database, the runtime file, the settings, and the backups. `T3_BACKUP_DIR` replaces the backup folder. `NO_COLOR` turns color off.

Output goes to stderr in the style of the Vercel CLI, so a pipe gets only data. `doctor --json` prints one document on stdout. A wrong command line exits with 2, and any other failure exits with 1.

## Set up a machine with the shell scripts

These scripts are being replaced by `devbox` commands. They still run on every box today.

Each machine runs [T3 Code](https://t3.codes), its browser, the languages, and Git as me. Nobody works in its terminal, so it skips [my dotfiles](https://github.com/PunGrumpy/dotfiles).

| Machine                                     | Folder                            |
| ------------------------------------------- | --------------------------------- |
| [Upstash Box](https://upstash.com/docs/box) | [`upstash/`](upstash/README.md)   |
| [instabox](https://instabox.sh)             | [`instabox/`](instabox/README.md) |

### What every machine gets

[`common/`](common) holds the parts that do not depend on the provider:

| Script                                      | What it does                                                                                                                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`t3.sh`](common/t3.sh)                     | Installs or updates T3 Code from the `nightly` channel (`DEVBOX_T3_CHANNEL` picks another), names the environment, then starts `t3 serve` on port 3773. Turns off Chrome's sandbox when the machine blocks it. |
| [`browser-deps.sh`](common/browser-deps.sh) | Installs the libraries and fonts T3's browser needs. Debian and Ubuntu only.                                                                                                                                   |
| [`env.sh`](common/env.sh)                   | Sets Git to commit as me without signing, since the signing key lives in 1Password. Puts the languages on `PATH` for T3, its agents, and login shells.                                                         |
| [`skills.sh`](common/skills.sh)             | Installs the same agent skills as [my dotfiles](https://github.com/PunGrumpy/dotfiles), for Claude Code and Codex. It reads the list from the dotfiles and reinstalls only when the list changes.              |
| [`pair.sh`](common/pair.sh)                 | Installs `~/.local/bin/devbox-pair`, which prints the machine's public T3 URL and a one-time pairing token for [`link.sh`](link.sh).                                                                           |
| [`tools.sh`](common/tools.sh)               | Installs Go and Rust with [mise](https://mise.jdx.dev/), into `DEVBOX_DATA` so a rebuild keeps them. The machine image brings the rest.                                                                        |

### Add a machine

Make a folder with a `start.sh` that the provider runs on boot. It sets `DEVBOX_NAME` and `DEVBOX_DATA`, the directory that survives a rebuild, then calls the `common/` scripts. [`upstash/start.sh`](upstash/start.sh) is the example.

### Link a machine

So agents on a computer can work on a box, link the box as a T3 environment there. Run this on each computer you use T3 from, with the box's SSH host:

```sh
sh link.sh upstash-t3-box instabox-t3-box
```

It runs `devbox-pair` on each box over SSH, then `t3 environment link` here, so nothing asks for a pairing code. Links last 30 days, and running it again renews them.

That link is for agents. The T3 Code app keeps its own list of environments, so add `--app` to also send each box to the app here (`sh link.sh --app upstash-t3-box`). On a Mac the app asks you to confirm each one. From WSL the Windows app ignores those links, so `link.sh` copies each pairing URL to the clipboard instead: paste it in Settings → Connections → Add environment. Set `T3` when `t3` is not on `PATH`, and `DEVBOX_LINK_ACCESS` for less than `full-access`.

## Develop

```sh
bun test             # runs the commands in-process against fixture databases
bun run typecheck    # tsrs --noEmit
bun run check        # oxlint and oxfmt --check
bun run build        # dist/devbox
```
