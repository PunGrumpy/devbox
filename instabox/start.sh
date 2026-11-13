#!/bin/sh
# Replaces instabox's own start script for t3-instabox.service (see setup.sh).
# The same T3 command, but T3 listens on 127.0.0.1:3775 behind common/proxy.mjs
# on 3774, which the instabox HTTPS URL reaches. The proxy gives T3 the public
# host, so the Mac can link the machine.
set -eu
DEVBOX=$(cd "$(dirname "$0")/.." && pwd)
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

id=$(sed 's/^m_//' /etc/instabox/identity)
node "$DEVBOX/common/proxy.mjs" 3774 3775 "3774-$id.instabox.tech" &

identity=$(cat /etc/machine-id)
case "$identity" in '' | *[!a-f0-9]*) exit 1 ;; esac
# For link.sh. A failure must not stop T3 from starting.
sh "$DEVBOX/common/pair.sh" "$HOME/.local/bin/t3" "$HOME/.t3-instabox/$identity" \
  "https://3774-$id.instabox.tech" || echo "devbox: devbox-pair not installed"
exec t3 serve --host 127.0.0.1 --port 3775 --base-dir "$HOME/.t3-instabox/$identity" /data/workspace
