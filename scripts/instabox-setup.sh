#!/bin/sh
set -eu
DEVBOX_HOME=$(cd "$(dirname "$0")/.." && pwd)
export DEVBOX_HOME
id=$(sed 's/^m_//' /etc/instabox/identity)
sudo -n sh -c 'systemctl disable --now t3-instabox.service; rm -rf /etc/systemd/system/t3-instabox.service.d/devbox.conf' || true
exec sh "$DEVBOX_HOME/install.sh" up --port 3774 --public-url "https://3774-$id.instabox.tech" \
  --base-dir "$HOME/.t3-instabox/$(cat /etc/machine-id)" --workspace /data/workspace
