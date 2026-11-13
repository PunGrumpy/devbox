#!/bin/sh
# Link boxes as T3 environments on this computer, so agents here can work on
# them. Each box needs an SSH host here and devbox-pair there (common/pair.sh).
# Run it on every computer you use T3 from. Links last 30 days, and running it
# again renews them.
# Usage: sh link.sh [--app] <ssh host>...
# --app also adds each box to the T3 Code app on this computer, which keeps
# its own list under Settings -> Connections. The app asks to confirm each one.
# T3 picks the t3 binary (default: t3 on PATH). DEVBOX_LINK_ACCESS picks what
# agents here may do there (default: full-access).
set -u
app=0
[ "${1:-}" = --app ] && { app=1; shift; }
[ $# -gt 0 ] || { echo "usage: sh link.sh [--app] <ssh host>..." >&2; exit 2; }
t3=${T3:-t3}
access=${DEVBOX_LINK_ACCESS:-full-access}
# The box shows this name in Settings -> Connections.
label=$(hostname -s 2>/dev/null || hostname)

# Print "<url> <token>" from the box, with a new one-time token each time.
pair() {
  # The box's shell expands ~, not this one.
  # shellcheck disable=SC2088
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$1" "~/.local/bin/devbox-pair '$2'"
}

# Hand a t3code:// link to the app: WSL through Windows, then macOS, then Linux.
open_link() {
  if command -v explorer.exe >/dev/null; then
    explorer.exe "$1" || true # explorer.exe exits 1 even when it opens the link.
  elif command -v open >/dev/null; then
    open "$1"
  else
    xdg-open "$1"
  fi
}

status=0
for host in "$@"; do
  if ! out=$(pair "$host" "$label"); then
    echo "$host: devbox-pair failed" >&2
    status=1
    continue
  fi
  url=${out% *} token=${out##* }
  "$t3" environment link "$url" --pairing-code "$token" --access "$access" || status=1

  [ "$app" = 1 ] || continue
  if ! out=$(pair "$host" "$label app"); then
    echo "$host: devbox-pair failed" >&2
    status=1
    continue
  fi
  pairing=$(printf '%s/pair#token=%s' "${out% *}" "${out##* }" |
    sed 's/%/%25/g; s/:/%3A/g; s/\//%2F/g; s/#/%23/g; s/=/%3D/g')
  open_link "t3code://pair?pairingUrl=$pairing" || status=1
  echo "$host: confirm \"Add the backend\" in the T3 Code app"
done
exit $status
