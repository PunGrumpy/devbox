# Upstash Box

Only `/workspace` survives a box rebuild, so the box sets itself up again on every start.

## Create a box

1. In the Upstash Console, create a box, connect GitHub, and attach this repo. Upstash clones it to `/workspace/home/devbox`. The box name becomes the T3 Code environment name.
2. In **Settings → Init Command**, paste:

   ```sh
   sh /workspace/home/devbox/upstash/start.sh
   ```

   `start.sh` pulls this repo on every start, then runs the new copy. Keep the command this short: when a longer clone-and-pull command was pasted, the box received only part of it.

3. Start the box. T3 Code comes up in a few seconds. Go and Rust take a few minutes the first time.

Logs go to `/workspace/home/.devbox-logs`: `start.log` for the start, `setup.log` for the browser libraries and the languages.

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
