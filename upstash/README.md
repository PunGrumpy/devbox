# Upstash Box

Only `/workspace` survives a box rebuild, so the box sets itself up again on every start.

## Create a box

1. In the Upstash Console, create a box and connect GitHub. The box name becomes the T3 Code environment name.
2. In **Settings → Init Command**, paste:

   ```sh
   d=/workspace/home/devbox; git -C $d pull -q --ff-only 2>/dev/null || git clone -q https://github.com/PunGrumpy/devbox $d; sh $d/upstash/start.sh
   ```

3. Start the box. T3 Code comes up in a few seconds. The dotfiles take longer, because Homebrew builds part of the Brewfile on arm64 Linux.

Logs go to `/workspace/home/.devbox-logs`: `start.log` for the start, `setup.log` for the browser libraries and the dotfiles.

## Log in to GitHub as yourself

Upstash's GitHub connection logs gh in with an app token. To use your own account, and keep the login after a rebuild:

```sh
GH_CONFIG_DIR=/workspace/home/.config/gh gh auth login --web --git-protocol https
```

The next start links `~/.config/gh` to it.

## Limits

- Chrome runs with `--no-sandbox`. The box has no AppArmor and seccomp blocks user namespaces, so the container is the only isolation.
- The box cannot change its hostname, so the shell prompt shows the container id.
- The Console has no restart button. To run the Init Command again, pause and resume the box with the [`@upstash/box`](https://upstash.com/docs/box) SDK.
