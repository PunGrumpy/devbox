# instabox

[instabox](https://instabox.sh) machines are Firecracker VMs. Both disks survive a stop, and `$HOME` (`/data/home`) is on the data disk. instabox runs T3 Code itself. This folder adds Git as me and the agent skills, and keeps T3 on the same release channel as the Mac (`nightly`, or set `DEVBOX_T3_CHANNEL`). T3 updates every time its unit starts, so restart it to update: `sudo systemctl restart t3-instabox`.

## Set up a machine

1. In the instabox dashboard, create a machine with T3 Code turned on.
2. On the machine, run:

   ```sh
   git clone -q https://github.com/PunGrumpy/devbox ~/devbox && sh ~/devbox/instabox/setup.sh
   ```

   Run `sh ~/devbox/instabox/setup.sh` again to update it. It pulls this repo first.

3. Log in to GitHub as yourself. The skills from the private `PunGrumpy/agents` repo need it, so run the setup again afterwards:

   ```sh
   gh auth login --web --git-protocol https
   ```

## SSH

`ssh.instabox.sh` is a gateway, and it has no way to add your own SSH key. Log in with an `ibssh_` token instead: the user name is the token, so keep it out of this repo. Make one from your computer (a new token revokes the old one):

```sh
npx instabox@latest ssh-token <machine> --ttl never
```
