# devbox

Sets up a remote machine for coding agents the same way every time: [T3 Code](https://t3.codes), its browser, the languages, and Git as me. Nobody works in its terminal, so it skips [my dotfiles](https://github.com/PunGrumpy/dotfiles).

| Machine | Folder |
| --- | --- |
| [Upstash Box](https://upstash.com/docs/box) | [`upstash/`](upstash/README.md) |
| [instabox](https://instabox.sh) | [`instabox/`](instabox/README.md) |

## What every machine gets

[`common/`](common) holds the parts that do not depend on the provider:

| Script | What it does |
| --- | --- |
| [`t3.sh`](common/t3.sh) | Installs or updates T3 Code from the `nightly` channel (`DEVBOX_T3_CHANNEL` picks another), names the environment, then starts `t3 serve` on port 3773. Turns off Chrome's sandbox when the machine blocks it. |
| [`browser-deps.sh`](common/browser-deps.sh) | Installs the libraries and fonts T3's browser needs. Debian and Ubuntu only. |
| [`env.sh`](common/env.sh) | Sets Git to commit as me without signing, since the signing key lives in 1Password. Puts the languages on `PATH` for T3, its agents, and login shells. |
| [`skills.sh`](common/skills.sh) | Installs the same agent skills as [my dotfiles](https://github.com/PunGrumpy/dotfiles), for Claude Code and Codex. It reads the list from the dotfiles and reinstalls only when the list changes. |
| [`pair.sh`](common/pair.sh) | Installs `~/.local/bin/devbox-pair`, which prints the machine's public T3 URL and a one-time pairing token for [`link.sh`](link.sh). |
| [`tools.sh`](common/tools.sh) | Installs Go and Rust with [mise](https://mise.jdx.dev/), into `DEVBOX_DATA` so a rebuild keeps them. The machine image brings the rest. |

## Add a machine

Make a folder with a `start.sh` that the provider runs on boot. It sets `DEVBOX_NAME` and `DEVBOX_DATA`, the directory that survives a rebuild, then calls the `common/` scripts. [`upstash/start.sh`](upstash/start.sh) is the example.

## Link a machine

So agents on a computer can work on a box, link the box as a T3 environment there. Run this on each computer you use T3 from, with the box's SSH host:

```sh
sh link.sh upstash-t3-box instabox-t3-box
```

It runs `devbox-pair` on each box over SSH, then `t3 environment link` here, so nothing asks for a pairing code. Links last 30 days, and running it again renews them.

That link is for agents. The T3 Code app keeps its own list of environments, so add `--app` to also send each box to the app here (`sh link.sh --app upstash-t3-box`). The app asks you to confirm each one. Set `T3` when `t3` is not on `PATH`, and `DEVBOX_LINK_ACCESS` for less than `full-access`.
