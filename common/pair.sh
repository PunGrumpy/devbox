#!/bin/sh
# Install ~/.local/bin/devbox-pair, which link.sh runs over SSH to link this
# machine as a T3 environment. It prints the public T3 URL and a one-time
# pairing token: "<url> <token>". t3 pair alone cannot do that here: it needs
# the server's --base-dir, and it only knows the internal address.
# Usage: sh pair.sh <t3 binary> <T3 base dir> <public T3 URL>
set -eu
t3=$1 base=$2 url=$3

mkdir -p "$HOME/.local/bin"
cat >"$HOME/.local/bin/devbox-pair" <<SCRIPT
#!/bin/sh
# Written by devbox/common/pair.sh. Usage: devbox-pair [label]
set -eu
token=\$('$t3' pair --base-dir '$base' --ttl 15m --label "\${1:-devbox}" | sed -n 's/^Token: //p')
[ -n "\$token" ] || { echo "devbox-pair: t3 pair printed no token" >&2; exit 1; }
echo '$url' "\$token"
SCRIPT
chmod 755 "$HOME/.local/bin/devbox-pair"
