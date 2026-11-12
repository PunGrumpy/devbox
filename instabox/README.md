# instabox

[instabox](https://instabox.sh) machines are Firecracker VMs. Both disks survive a stop, and `$HOME` (`/data/home`) is on the data disk. instabox runs T3 Code itself, so this folder only adds Git as me and the agent skills.

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

`ssh.instabox.sh` is a gateway. It checks your login, then connects to the machine with its own key. So add your SSH key in the instabox dashboard, not to the machine. The dashboard's SSH button also prints a short-lived `ibssh_` user name that logs in without a key.
