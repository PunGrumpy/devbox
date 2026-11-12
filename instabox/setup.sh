#!/bin/sh
# Make an instabox machine work like my other boxes. instabox runs T3 Code
# itself, so this only adds Git as me and the agent skills. Run it once on a
# new machine, and again to update. See README.md in this folder.
set -u

DEVBOX=$(cd "$(dirname "$0")/.." && pwd)
git -C "$DEVBOX" pull -q --ff-only || echo "devbox: pull failed, running $(git -C "$DEVBOX" rev-parse --short HEAD)"
# Both disks survive a stop, and $HOME is on the data disk.
export DEVBOX_DATA="$HOME"

# env.sh sets Git through GIT_CONFIG_* for login shells. instabox starts T3
# from a systemd unit that reads no profile, so also write the same settings
# to ~/.gitconfig.
# shellcheck source=common/env.sh
. "$DEVBOX/common/env.sh"
key='' value=''
i=0
while [ "$i" -lt "$GIT_CONFIG_COUNT" ]; do
  eval "key=\$GIT_CONFIG_KEY_$i"
  git config --global --unset-all "$key" 2>/dev/null
  i=$((i + 1))
done
i=0
while [ "$i" -lt "$GIT_CONFIG_COUNT" ]; do
  eval "key=\$GIT_CONFIG_KEY_$i value=\$GIT_CONFIG_VALUE_$i"
  git config --global --add "$key" "$value"
  i=$((i + 1))
done

sh "$DEVBOX/common/skills.sh"
