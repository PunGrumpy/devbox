#!/bin/sh
# Link boxes as T3 environments on this computer, so agents here can work on
# them. Each box needs an SSH host here and devbox-pair there (common/pair.sh).
# Run it on every computer you use T3 from. Links last 30 days, and running it
# again renews them.
# Usage: sh link.sh <ssh host>...
# T3 picks the t3 binary (default: t3 on PATH). DEVBOX_LINK_ACCESS picks what
# agents here may do there (default: full-access).
set -u
[ $# -gt 0 ] || { echo "usage: sh link.sh <ssh host>..." >&2; exit 2; }
t3=${T3:-t3}
access=${DEVBOX_LINK_ACCESS:-full-access}
# The box shows this name in Settings -> Connections.
label=$(hostname -s 2>/dev/null || hostname)

status=0
for host in "$@"; do
  # The box's shell expands ~, not this one.
  # shellcheck disable=SC2088
  if ! out=$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$host" "~/.local/bin/devbox-pair '$label'"); then
    echo "$host: devbox-pair failed" >&2
    status=1
    continue
  fi
  url=${out% *} token=${out##* }
  "$t3" environment link "$url" --pairing-code "$token" --access "$access" || status=1
done
exit $status
