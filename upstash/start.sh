#!/bin/sh
# Upstash Box Init Command entry point. See README.md in this folder.
set -u

DEVBOX=$(cd "$(dirname "$0")/.." && pwd)
# Prefixed so T3 tells it apart from boxes on other providers.
export DEVBOX_NAME="upstash-${UPSTASH_BOX_NAME:-$(hostname)}"
# Only /workspace survives a rebuild. $HOME and the rest of the disk do not.
export DEVBOX_DATA=/workspace/home
LOGS="$DEVBOX_DATA/.devbox-logs"
mkdir -p "$LOGS"
exec >>"$LOGS/start.log" 2>&1
echo "== $(date '+%F %T') $DEVBOX_NAME as $(id -un)"

# Update this repo, then run the new copy of this script. The Console keeps
# only the short Init Command, so the update has to happen here.
if [ -z "${DEVBOX_UPDATED:-}" ]; then
  git -C "$DEVBOX" pull -q --ff-only || echo "devbox: pull failed, running $(git -C "$DEVBOX" rev-parse --short HEAD)"
  DEVBOX_UPDATED=1 exec sh "$DEVBOX/upstash/start.sh"
fi

# Keep your own gh login on /workspace once it is saved there.
if [ -f "$DEVBOX_DATA/.config/gh/hosts.yml" ] && [ ! -L "$HOME/.config/gh" ]; then
  mkdir -p "$HOME/.config"
  rm -rf "$HOME/.config/gh"
  ln -s "$DEVBOX_DATA/.config/gh" "$HOME/.config/gh"
fi

# Before T3 starts, so its agents inherit it.
. "$DEVBOX/common/env.sh"
sh "$DEVBOX/common/t3.sh"

# Slow, and T3 does not need it to start.
setsid nohup sh -c "
  echo \"== \$(date '+%F %T') setup\"
  sh '$DEVBOX/common/browser-deps.sh'
  sh '$DEVBOX/common/tools.sh'
  sh '$DEVBOX/common/skills.sh'
  echo \"== \$(date '+%F %T') setup exit=\$?\"
" >>"$LOGS/setup.log" 2>&1 </dev/null &
