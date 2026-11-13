#!/bin/sh
# Link boxes as T3 environments on this computer, so agents here can work on
# them. Each box needs an SSH host here and devbox-pair there (common/pair.sh).
# Run it on every computer you use T3 from. Links last 30 days, and running it
# again renews them.
# Usage: sh link.sh [--app] <ssh host>...
# --app also adds each box to the T3 Code app on this computer, which keeps
# its own list under Settings -> Connections. On macOS and Linux the app asks
# to confirm each one. From WSL, the Windows app ignores t3code:// links, so
# the pairing URL goes to the clipboard for Settings -> Connections -> Add
# environment, one box at a time.
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

# Give the app a pairing URL: through the clipboard from WSL, else as a
# t3code:// link that the app opens with a confirmation.
to_app() {
  if command -v clip.exe >/dev/null; then
    printf '%s' "$2" | clip.exe || return 1
    printf '%s: pairing URL copied. In T3 Code, Settings -> Connections -> Add environment, paste it, then press Enter here. ' "$1"
    read -r _ </dev/tty
    return
  fi
  link="t3code://pair?pairingUrl=$(printf '%s' "$2" |
    sed 's/%/%25/g; s/:/%3A/g; s/\//%2F/g; s/#/%23/g; s/=/%3D/g')"
  if command -v open >/dev/null; then open "$link"; else xdg-open "$link"; fi || return 1
  echo "$1: confirm \"Add the backend\" in the T3 Code app"
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
  to_app "$host" "${out% *}/pair#token=${out##* }" || status=1
done
exit $status
