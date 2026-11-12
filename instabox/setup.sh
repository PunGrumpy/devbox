#!/bin/sh
# Make an instabox machine work like my other boxes. instabox runs T3 Code
# itself, so this adds Git as me, the agent skills, pstack's models, and T3 on
# the Mac's release channel. Run it once on a new machine, and again to update.
# See README.md in this folder.
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
sh "$DEVBOX/common/pstack.sh"

# instabox ships a fixed T3 release. Update to the Mac's channel before every
# start of its unit. The npm download can take longer than systemd's default
# 90 seconds, and the leading - starts T3 anyway if the update fails. Then
# start T3 behind common/proxy.mjs (see instabox/start.sh).
dropin=$(mktemp)
cat >"$dropin" <<UNIT
[Service]
ExecStartPre=-/bin/sh $DEVBOX/instabox/t3.sh
ExecStart=
ExecStart=/bin/sh $DEVBOX/instabox/start.sh
TimeoutStartSec=5min
UNIT
sudo -n install -D -m 644 "$dropin" /etc/systemd/system/t3-instabox.service.d/devbox.conf
rm -f "$dropin"
sudo -n systemctl daemon-reload
sudo -n systemctl restart t3-instabox.service
