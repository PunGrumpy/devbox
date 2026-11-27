# devbox

`devbox` is one command-line tool for machines that run [T3 Code](https://t3.codes) coding agents. It sets up any Linux machine, keeps T3 Code running there, links machines to the computers you use T3 from, backs up agent memory and threads, and maintains T3 Code's local state. Anything that differs between machines is a flag, not a folder named after a provider.

`devbox` is TypeScript on [Bun](https://bun.sh) and [Effect](https://effect.website).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/PunGrumpy/devbox/main/install.sh | sh -s -- up
```

`install.sh` installs Bun when it is missing, clones this repo into `$DEVBOX_HOME` (default `~/.devbox`) or fast-forwards it, installs the dependencies, writes a `devbox` wrapper to `~/.local/bin`, and runs `devbox` with its arguments. Run it again to update. `DEVBOX_REPO` clones from somewhere else.

Bun's installer needs `unzip`. When Bun and `unzip` are both missing, `install.sh` installs `unzip` with `apt-get` if you are root or have passwordless sudo. Otherwise it stops and prints the command for an admin to run: `sudo apt-get install -y unzip`.

## Set up a machine

```sh
devbox up --name edge-7 --data /persist --public-url https://edge-7.example.com
```

`devbox up` reads the machine as it is, changes only what differs, and says what it changed. A second run prints `No changes`.

| Flag           | Default      | What it sets                                                                                                                              |
| -------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--name`       | the hostname | The environment name T3 Code shows, as `PRETTY_HOSTNAME` in `/etc/machine-info`.                                                          |
| `--data`       | `$HOME`      | The directory that survives a rebuild. T3 Code, mise, Rust, Claude Code and agent skills keep their data here.                            |
| `--public-url` | none         | The origin an edge proxy serves the machine on. T3 then runs behind a proxy that gives it this host, so OAuth and pairing URLs use it.    |
| `--port`       | `3773`       | The port T3 Code answers on, directly or through the proxy.                                                                               |
| `--host`       | `0.0.0.0`    | The address T3 Code listens on, so every interface. Not with `--public-url`, where T3 listens on `127.0.0.1` behind the proxy.            |
| `--base-dir`   | `<data>/.t3` | T3 Code's data directory.                                                                                                                 |
| `--workspace`  | `<data>`     | The working directory for agent sessions.                                                                                                 |
| `--channel`    | `nightly`    | The npm dist-tag T3 Code installs and updates from.                                                                                       |
| `--supervisor` | `auto`       | What keeps T3 running: a systemd system unit when systemd and passwordless sudo exist, else a systemd user unit, else a detached process. |
| `--agents`     | ask once     | The agent CLIs to install: `pick`, `none`, or a list like `claude,codex`. Saved in `<data>`, so later runs ask nothing.                   |
| `--no-setup`   | setup runs   | Skips the slow setup that runs after T3 starts.                                                                                           |

What it does:

- Sets Git to commit as me without signing, and to log in to github.com through `gh`, in `~/.gitconfig`.
- With passwordless sudo, writes `/etc/machine-info` and `/etc/profile.d/devbox.sh`, which puts the languages on `PATH` and keeps tool data in `--data` for login shells. Without it, it skips both with a note.
- When `--data` is not `$HOME`, links `~/.agents` into it, and `~/.config/gh` once a gh login is saved there.
- Turns on `"linkedEnvironmentsEnabled"` in `<base dir>/userdata/settings.json`, which `t3 environment link` needs on the machine being linked. It keeps every other key, creates the file with mode 600 when it is missing, and leaves a file that is not a JSON object alone with a note. A running T3 reads the file when it changes, so this does not restart it.
- Installs or updates T3 Code from npm into `<data>/.local`, and installs the [agent CLIs](#agent-clis) you chose that are missing.
- When `~/.config/devbox/backup/env` sets `RESTIC_REPOSITORY`, installs `restic` and `sqlite3` with apt if they are missing, and enables a nightly backup timer. See [Back up agent memory](#back-up-agent-memory). Without that file it prints one line saying backups are off.
- Keeps `devbox serve` running under the supervisor, and restarts it when T3 Code updates or the flags change. It waits until T3 answers on the port.

`devbox serve` takes the same flags. It probes user namespaces and turns off Chrome's sandbox when the machine blocks them, starts the proxy when `--public-url` is set, and runs `t3 serve`. Once T3 answers it installs the browser's libraries with apt, Go, Rust and Starship with [mise](https://mise.jdx.dev/) (and `gh` when the machine has none), updates the agent CLIs it keeps current, and installs the agent skills from [my dotfiles](https://github.com/PunGrumpy/dotfiles) for the chosen agents that take skills. It also sets up [the shell](#shell). That never blocks T3. The skills list is parsed as data, never run, and installs again when it changes or when you choose another agent.

When Claude Code is one of the agents, it also links `CLAUDE.md` in every Claude home to [`instructions/AGENTS.md`](instructions/AGENTS.md) in this checkout: `$CLAUDE_CONFIG_DIR`, and the `homePath` of each Claude provider instance in T3's `settings.json`. A new machine has none of the memory agents built up elsewhere, and that memory holds paths, shells and credentials of the machine it was written on, so the rules travel and the memory does not. Because they are links, updating this checkout updates every home. `devbox` replaces a `CLAUDE.md` that is an exact copy of the file, and leaves any other `CLAUDE.md` or link alone with a note.

Logs of a detached `devbox serve` go to `<data>/.devbox-logs/serve.log`. A systemd unit logs to the journal: `journalctl -u devbox` or `journalctl --user -u devbox`.

### Shell

`devbox serve` gives you zsh with a [Starship](https://starship.rs) prompt in the style of the [Geist terminal](https://vercel.com/geist/terminal). The prompt adds the host name, so a devbox never looks like your laptop. Colors and the font come from your own terminal app.

- With passwordless sudo it installs zsh with apt and makes it your login shell. Without it, it prints the command for an admin to run.
- It links `~/.zprofile`, `~/.zshrc` and `~/.config/starship.toml` to [`shell/`](shell) in this checkout, and leaves a file that is not its own alone with a note. Put settings for one machine in `~/.zshrc.local`.
- T3 Code and its agents keep `SHELL=/bin/bash`, so agent commands run as before.

### Agent CLIs

T3 Code finds an agent by its binary name on `PATH`, so a fresh machine needs the CLIs installed. `devbox up` installs the ones you choose. The first time it runs on a terminal it asks, and it saves the answer in `<data>/.config/devbox/agents.json`. Later runs read that file and ask nothing. Without a terminal and without that file (Upstash, instabox, a systemd start) it installs the defaults, Claude Code and Codex, and saves nothing, so the next run on a terminal still asks.

| Agent           | `--agents` id | Installed with                                                                  | Kept current by              | Log in once with                          |
| --------------- | ------------- | ------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------- |
| Claude Code     | `claude`      | `claude.ai/install.sh`, into `<data>/.local/bin`                                | itself                       | `claude auth login`                       |
| Codex           | `codex`       | npm, `@openai/codex`, into `<data>/.local`                                      | `devbox serve` at each start | `codex login --device-auth`               |
| Devin           | `devin`       | `cli.devin.ai/install.sh`, into `<data>/.local/bin`                             | `devin update` on a terminal | `devin configure`                         |
| OpenCode        | `opencode`    | npm, `opencode-ai`, into `<data>/.local`                                        | `devbox serve` at each start | `opencode auth login`                     |
| Antigravity CLI | `agy`         | `antigravity.google/cli/install.sh`, into `<data>/.local/bin`                   | itself                       | `agy`, then sign in on its welcome screen |
| Grok Build      | `grok`        | `x.ai/cli/install.sh`, into `<data>/.grok/bin`, linked into `<data>/.local/bin` | itself                       | `grok login --device-auth`                |

```sh
devbox up --agents claude,codex,devin   # set the list; it is saved
devbox up --agents pick                 # ask again, with the saved list ticked
devbox up --agents none                 # manage no agent CLI
```

`--agents` replaces the saved list, so add or drop one by naming the new list. A dropped agent stays installed and logged in. `devbox` stops updating it and giving it skills, and prints the command that removes it. Logging in stays yours: after installing an agent, `devbox up` prints the command. An install that fails prints a failed check and does not fail `up`, and the next run tries again. Installing an agent restarts T3 Code, so it sees the new binary. Installing does not turn on the agent's provider in T3 Code: if T3 lists it as off, turn it on in its settings.

The file lives in `--data`, not `~/.config`, because on Upstash only `/workspace` survives a rebuild. Run `devbox up` with the same `--data` the box uses.

### Keep T3 on the tailnet only

By default T3 listens on every interface, including a cloud's private network. To make it reachable only over [Tailscale](https://tailscale.com), listen on the machine's Tailscale address:

```sh
devbox up --host "$(tailscale ip -4)"
```

`devbox up` and `devbox serve` pass `--host` to `t3 serve`. `devbox up` also probes that address, not `127.0.0.1`, to see whether T3 answers, and a changed `--host` restarts `devbox serve`. `--host 0.0.0.0` or `::` listens on every interface. Run `devbox up` after Tailscale is up, because T3 cannot bind an address the machine does not have yet.

### Reach T3 without Tailscale

A phone without Tailscale can reach T3 through your own [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/). T3 keeps listening on the Tailscale address, and Tailscale keeps working. You need a domain on Cloudflare. The T3 sign-in page becomes public, so do not do this on a machine that must stay private.

1. Create a tunnel in the Cloudflare dashboard, and copy its token. Do not add a route yet.
2. Put `cloudflared` at `~/.local/bin/cloudflared`: run `mise use -g cloudflared`, then `ln -sfn "$(mise which cloudflared)" ~/.local/bin/cloudflared`.
3. Save the token to `~/.config/cloudflared/token` with mode 600.
4. Write `~/.config/systemd/user/cloudflared-t3.service`:

   ```ini
   [Unit]
   Description=Cloudflare Tunnel for T3 Code

   [Service]
   ExecStart=%h/.local/bin/cloudflared tunnel --no-autoupdate run --token-file %h/.config/cloudflared/token
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=default.target
   ```

5. Add a WAF custom rule that blocks `/mcp` and `/oauth/mcp` on the hostname. T3 matches `/mcp` without regard to case, so compare in lower case:

   ```text
   (http.host eq "t3.example.com" and (starts_with(lower(http.request.uri.path), "/mcp") or starts_with(lower(http.request.uri.path), "/oauth/mcp")))
   ```

6. Start the tunnel: `systemctl --user daemon-reload`, then `systemctl --user enable --now cloudflared-t3`. To keep it running after you log out, run `sudo loginctl enable-linger "$USER"` once.
7. Add a published application route from the hostname to `http://<tailscale ip>:3773`. T3 is public from this step.
8. Pair each device with its own code: `devbox pair --label iphone --url https://t3.example.com`. For a machine that the app already has, paste the pairing URL into **Add route**.

Use one tunnel and one hostname for each machine. T3 answers at the root of its origin, so a path cannot select a machine. Cloudflare's free certificate covers `t3-2.example.com` but not `2.t3.example.com`. Do not put Cloudflare Access or a challenge on the hostname, because the T3 app sends no Access headers.

`devbox link` needs `/mcp`, so keep linking machines over Tailscale. `t3 auth session revoke` on a Mac or PC session also ends that device's other sessions, so pair it again after you use the command.

### Upstash Box

Only `/workspace` survives a rebuild, so the box sets itself up on every start. In the Upstash Console, under **Settings → Init Command**, paste:

```sh
d=/workspace/home/devbox; git -C $d pull -q --ff-only 2>/dev/null || git clone -q https://github.com/PunGrumpy/devbox $d; sh $d/upstash/start.sh
```

[`upstash/start.sh`](upstash/start.sh) runs `devbox up --data /workspace/home --name upstash-<box name> --public-url https://<box id>-3773.preview.box.upstash.com`, and logs to `/workspace/home/.devbox-logs/start.log`. The box writes the Init Command into `/workspace/home/.box/startup.sh` only when it starts. To run it again, pause and resume the box with the [`@upstash/box`](https://upstash.com/docs/box) SDK.

Upstash's GitHub connection logs gh in with an app token. To use your own account and keep it after a rebuild, log in once; the next start links `~/.config/gh` to it:

```sh
GH_CONFIG_DIR=/workspace/home/.config/gh gh auth login --web --git-protocol https
```

The box has no AppArmor and blocks user namespaces, so Chrome runs with `--no-sandbox` and the container is the only isolation.

### instabox

Create a machine with T3 Code turned on, then run this on it, and again to update:

```sh
git -C ~/devbox pull -q --ff-only 2>/dev/null || git clone -q https://github.com/PunGrumpy/devbox ~/devbox; sh ~/devbox/instabox/setup.sh
```

[`instabox/setup.sh`](instabox/setup.sh) turns off instabox's own `t3-instabox` unit and runs `devbox up --port 3774 --public-url https://3774-<id>.instabox.tech` with instabox's T3 data directory and `/data/workspace`, so threads carry over. The skills from the private `PunGrumpy/agents` repo need your gh login: run `gh auth login --web --git-protocol https`, then the setup again.

`ssh.instabox.sh` cannot take your own SSH key. Log in with an `ibssh_` token as the user name, and keep it out of this repo. A new token revokes the old one: `npx instabox@latest ssh-token <machine> --ttl never`.

## Link a machine

So agents on a computer can work on a machine, link it as a T3 environment there. Run this on each computer you use T3 from, with the machines' SSH hosts:

```sh
devbox link edge-7 edge-8
```

It runs `devbox pair --json` on each machine over SSH, then `t3 environment link` here, so nothing asks for a pairing code. Links last 30 days, and running it again renews them. `--access` picks what agents here may do there (default `full-access`), and `--t3` the `t3` binary here.

That link is for agents. The T3 Code app keeps its own list, so `--app` also sends each machine to the app here. On macOS and Linux it opens a `t3code://` link that the app asks you to confirm. From WSL the Windows app ignores those links, so it copies each pairing URL to the clipboard and waits for Enter while you paste it in Settings → Connections → Add environment.

`devbox pair [--label <name>] [--url <origin>] [--json]` prints the machine's T3 URL and a one-time pairing token that lasts 15 minutes. `--json` prints `{"url", "token"}`. The URL is `--url` when you pass it, for example the hostname of a [tunnel](#reach-t3-without-tailscale). Without it, the URL is `--public-url` when the machine has one. Otherwise, on a machine on Tailscale, it is `http://<MagicDNS name>:<port>`, because `t3 environment link` refuses plain http to anything but a Tailscale address. With neither it is `http://<hostname>:<port>`.

## See your machines

`devbox machines` lists every machine on your tailnet and every T3 environment linked here. For each it shows where the machine is, whether T3 Code answers there, and whether agents here have a link to it. Phones and TVs are left out. `--json` prints the same list on stdout for scripts and agents.

It reads `tailscale status --json`, or `tailscale.exe` under WSL, and asks each online machine for T3's `/.well-known/t3/environment` on port 3773 (`--t3-port`). Links come from `t3 environment list --json`. `--t3` picks the `t3` binary, which is otherwise `t3` on PATH or the T3 server that is running. Without Tailscale it lists only this machine and its links.

Each machine has a `kind`: `mac`, `windows`, `wsl`, `vm`, `computer` or `remote`. Tailscale tells a peer only a machine's name and system, so `vm` shows only for the machine the command runs on, from `systemd-detect-virt`. `wsl` is a Windows machine whose T3 Code says it runs on Linux, and `remote` is a linked machine that is not on the tailnet.

`devbox hub` serves the same data as JSON at `/api/machines`, and the page in [`hub/`](hub) at `/`. It checks every minute and keeps the last 24 hours in memory. A request never starts a check. To open the page from your other devices, listen on the Tailscale address:

```sh
devbox hub --host "$(tailscale ip -4)"
```

The page has no login. Keep it on `127.0.0.1` or a Tailscale address.

The hub saves its history to `~/.local/state/devbox/hub.json` after every check and takes it up again when it starts. The time it was down shows as unknown. Under each machine the page says how much of the last 24 hours it was online, and names a newer T3 Code when the nightly channel has one.

To hear when a machine drops off, set `DEVBOX_HUB_NOTIFY` to one webhook URL in the hub's environment. A change is sent once it has held for two checks, so one missed answer is not news. Discord gets `{"content": "edge-7 went offline"}`, Slack gets `{"text": ...}`, and any other address, such as an [ntfy](https://ntfy.sh) topic, gets the sentence as plain text. The address is never logged.

The page is a Next.js app that builds to static files, so the hub needs no Node server. Build it once on the machine that runs the hub, and again after an update:

```sh
cd hub && bun install --frozen-lockfile && bun run build
```

`devbox hub` then serves `hub/out` from this checkout. `--ui <dir>` serves another build, which a compiled `devbox` binary needs. Without a build, `/` answers 404 with this command and the JSON still works.

To work on the page, run `devbox hub` and then `bun run dev` in `hub/`. Next serves the page on port 3790 and forwards `/api/machines` to the hub at `DEVBOX_HUB_URL` (default `http://127.0.0.1:3780`). `hub/` is its own package with its own lockfile: `bun run check` runs [Ultracite](https://www.ultracite.dev), `bun run typecheck` runs [tsrs](https://github.com/oxc-project/tsrs), and `bun test` runs its tests.

The page's line icons come from [Hugeicons](https://hugeicons.com) (MIT) and its Linux mark from [Unicons](https://github.com/Iconscout/unicons) (Apache 2.0).

## Back up agent memory

Agents keep their memory and threads in files under `~`. `devbox backup` copies them every night to an encrypted [restic](https://restic.net) repository. The repository can be a Cloudflare R2 bucket.

```sh
devbox backup run      # snapshot SQLite files, back up, prune old snapshots
devbox backup verify   # restore the latest SQLite snapshots and open each one
devbox backup restore <target-dir> [--snapshot <id>]   # restore everything into a folder
devbox backup sources  # list the sources that exist on this machine
```

### Set it up

1. In the Cloudflare dashboard, open R2 and create a bucket, for example `agent-backup`.
2. Open R2, then **Manage API tokens**, then create an API token. Pick **Object Read & Write** and limit it to that bucket. Prune needs the delete permission, which this one includes.
3. Copy the **Access Key ID** and **Secret Access Key**. The secret is shown once. Your account ID is the first part of the S3 endpoint, `https://<account id>.r2.cloudflarestorage.com`.
4. On the machine, run `devbox backup sources`. It writes `~/.config/devbox/backup/` with `sources`, `excludes` and an `env` file that only you can read. It never overwrites a file that exists.
5. Fill in `env`:

```sh
RESTIC_REPOSITORY=s3:https://<account id>.r2.cloudflarestorage.com/agent-backup/<machine name>
RESTIC_PASSWORD_FILE=/home/<you>/.config/devbox/backup/restic-password
AWS_ACCESS_KEY_ID=<access key id>
AWS_SECRET_ACCESS_KEY=<secret access key>
AWS_DEFAULT_REGION=auto
```

6. Create the password and put a copy in your password manager now:

```sh
(umask 077; openssl rand -base64 32 > ~/.config/devbox/backup/restic-password)
```

7. Run `devbox backup run`, then `devbox backup verify`. The first run creates the repository.
8. Run `devbox up` again. With systemd it installs `devbox-backup.service` and `devbox-backup.timer`, which run `devbox backup run` every day at 03:30 Asia/Bangkok, up to 20 minutes late. The timer catches up after downtime. It lives in the same scope as the T3 unit, so a system unit runs as your user and a user unit uses lingering. Without systemd, run `devbox backup run` from cron.

### Keep the password off the VPS

The repository is useless without the password. If the only copy sits on the machine that dies, every backup is lost. Keep the master copy in a password manager. The copy in `env` is there so the timer can run. Use a token that reaches only this bucket.

### What a run does

- Reads `sources`: one `<name> <path>` per line, `~` allowed. Add an agent by adding a line. A path that does not exist is skipped with a note. A line that is not `<name> <path>` stops the run.
- Finds every SQLite file under a source by its first 16 bytes, not by its extension. Gemini uses `.db` and Codex uses `.sqlite`, and a file with those names may not be a database. It skips files and folders that `excludes` names.
- Snapshots each one with `sqlite3 .backup` into `~/.local/state/devbox/backup/sqlite/<name>/`, checks it with `pragma quick_check`, and leaves the live file and its `-wal`, `-shm` and `-journal` out of restic. Any `*.sqlite-wal`, `*.sqlite-shm`, `*.db-wal` and `*.db-shm` file is left out too. Copying a live WAL database can capture a torn state.
- Writes `.manifest.json` next to the snapshots. It lists each snapshot's source name, source path and path inside the source, so a restore does not depend on the current `sources` file.
- If `.backup` does not finish in two minutes, because the database is written too often, it uses `VACUUM INTO` instead.
- Runs `restic backup --tag agent-backup --exclude-caches` with those exclusions and your `excludes` file, then `restic forget --prune` to keep 7 daily, 4 weekly and 6 monthly snapshots. `forget` and `restore` only look at snapshots of this machine. The machine name is the host name. Set `RESTIC_HOST` in `env` to change it.
- Creates the repository only when restic says it does not exist.
- Takes a lock, so two runs never overlap. A lock counts only while its process is a `devbox backup` run. A lock file that is empty or unreadable counts for 10 seconds, then it is stale.

`excludes` is a restic exclude file. restic expands `$HOME` in it. `env` is read by `devbox` and its values are never printed.

### Restore

On a new machine, install `restic`, fill in `~/.config/devbox/backup/env` with the same repository and password, then run:

```sh
devbox backup restore ~/restore            # latest snapshot of this machine
devbox backup restore ~/restore --snapshot 1a2b3c4d
```

It runs `restic restore` into the folder. Files land at `<folder>/<original path>`, for example `~/restore/home/<you>/.claude`. Then it puts each SQLite snapshot at its live path inside the folder, for example `~/restore/home/<you>/.t3/userdata/statev2.sqlite`. It never writes outside the folder.

It prints the folders to move into place. Stop the agents first. Delete any `-wal` or `-shm` file next to a database you replace, or SQLite may replay old changes into the restored file. Then move the files:

```sh
cp -a ~/restore/home/<you>/.t3/userdata/. ~/.t3/userdata/
```

`restore` reads `.manifest.json` from the snapshot. If the snapshot has none, it maps each staged folder to a path with the `sources` file.

To look around by hand, use restic directly:

```sh
set -a; . ~/.config/devbox/backup/env; set +a
restic snapshots
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

## Develop

```sh
bun test             # runs the commands in-process against fixture databases
bun run typecheck    # tsrs --noEmit
bun run check        # oxlint and oxfmt --check
bun run build        # dist/devbox
```
