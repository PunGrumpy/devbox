# AGENTS.md

Guide for coding agents working in this repository. The README says what devbox does for the person who runs it. This file says how the repo is put together and what not to break.

## What this is

devbox sets up a machine to run T3 Code and coding agents, and shows every machine you have on one page. It is a Turborepo workspace on Bun with one lockfile.

## Repo map

```
apps/cli/                The `devbox` command, on Bun and Effect
  src/cli.ts             Entry. Every command is registered here
  src/machine/           `up`, `serve`, `pair`, `link`: what sets up one machine
  src/hub/               `hub`: the API behind the page, the Cloudflare client, tunnels
  src/spoke/             `spoke`: what each machine answers the hub with, and the signed actions it takes
  src/backup/            `backup`: agent memory to a restic repository
  src/migrate/           `migrate`: moves T3 Code's threads and Claude's files between paths
  shell/                 zsh and Starship files that `up` links into a home directory
  instructions/          The AGENTS.md that `up` links as CLAUDE.md into every Claude home
  test/                  bun:test, one file per feature, with a fake machine in test/support
apps/hub/                The hub page, a Next.js app that exports static files
  app/ components/ lib/  The page, its parts, and the code with no React in it
  test/                  bun:test for lib/
scripts/                 Start scripts for hosted boxes (Upstash Box, instabox)
install.sh               What a machine runs to install or update devbox
```

## Commands

```sh
bun install          # every package
bun run dev          # the hub on port 3780 and its page on port 3790
bun run check        # lint and format, for the whole repo
bun run fix          # format, and fix what a tool can
bun run typecheck
bun run test
bun run build        # apps/cli/dist/devbox and apps/hub/out
```

`typecheck`, `test` and `build` run through `turbo`. Add `-- --filter devbox` or `-- --filter hub` for one package. `check` and `fix` run Ultracite once for the repo. All four of `check`, `typecheck`, `test` and `build` must pass before a change is done.

## Rules

- **The repo is public.** No real hostname, tailnet name, IP address, environment id, URL or token goes into any file. Write `edge-7`, `tail1234.ts.net`, `example.com`. The page's lint forbids IP literals, so write `tailscale-ip-21` there.
- **Never print or log a secret.** Tokens, keys and pairing links stay out of logs, snapshots, error messages and tests. Tests use made-up values.
- **Do not run `devbox up` to try a change.** It installs software and writes systemd units on the machine it runs on. Tests drive it against the fake machine in `apps/cli/test/support`.
- **Never call a real service from a test.** Cloudflare, Tailscale and T3 Code are each replaced by a fake.
- **One lint config covers both apps.** `oxlint.config.ts` at the root is Ultracite, which is strict. `bun run fix` formats and fixes what a tool can. The CLI is exempt from the rules that misread Effect code, and each exemption gives its reason in that file. Do not turn off another rule to let a finding through.
- **The CLI follows Effect's style**: services, `Schema` at every boundary, the `Host` service for everything that touches the machine.
- **Tests assert what a user or caller can observe**, not how the code gets there.

## Paths that machines depend on

A machine that has devbox installed holds these paths. Moving one breaks every such machine until it runs `install.sh` again, so treat a move as a change to a public interface.

| Path | Who holds it |
| --- | --- |
| `install.sh` | The install command in the README, and both scripts in `scripts/` |
| `apps/cli/src/cli.ts` | The `devbox` wrapper in `~/.local/bin` and every systemd unit |
| `apps/cli/shell/*` | Links from `~/.zshrc`, `~/.zprofile` and `~/.config/starship.toml` |
| `apps/cli/instructions/AGENTS.md` | Links named `CLAUDE.md` in every Claude home |
| `apps/hub/out` | `devbox hub`, which serves the built page from there |
| `scripts/upstash-start.sh` | The Init Command pasted into the Upstash Console |
| `scripts/instabox-setup.sh` | The setup command in the README |

`devbox up` replaces a link whose target is gone, so a moved file under `shell/` or `instructions/` heals on the next `up`. Nothing heals the other rows.
