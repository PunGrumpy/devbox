# devbox

Sets up a remote dev machine the same way every time: [T3 Code](https://t3.codes), its browser, and [my dotfiles](https://github.com/PunGrumpy/dotfiles). The dotfiles stay generic. Anything a remote machine needs lives here.

| Machine | Folder |
| --- | --- |
| [Upstash Box](https://upstash.com/docs/box) | [`upstash/`](upstash/README.md) |

## What every machine gets

[`common/`](common) holds the parts that do not depend on the provider:

| Script | What it does |
| --- | --- |
| [`t3.sh`](common/t3.sh) | Names the T3 Code environment, then starts `t3 serve` on port 3773. Turns off Chrome's sandbox when the machine blocks it. |
| [`browser-deps.sh`](common/browser-deps.sh) | Installs the libraries and fonts T3's browser needs. Debian and Ubuntu only. |
| [`dotfiles.sh`](common/dotfiles.sh) | Applies the dotfiles with chezmoi, then updates them on every later start. |
| [`git.sh`](common/git.sh) | Turns off commit signing. The signing key lives in 1Password, which a remote machine cannot reach. |

## Add a machine

Make a folder with a `start.sh` that the provider runs on boot. It sets `DEVBOX_NAME` and `DEVBOX_DATA`, the directory that survives a rebuild, then calls the `common/` scripts. [`upstash/start.sh`](upstash/start.sh) is the example.
