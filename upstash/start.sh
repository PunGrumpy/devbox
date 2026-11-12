#!/bin/sh
# Upstash Box Init Command entry point. See README.md in this folder.
set -u

DEVBOX=$(cd "$(dirname "$0")/.." && pwd)
export DEVBOX_NAME="${UPSTASH_BOX_NAME:-$(hostname)}"
# Only /workspace survives a rebuild. $HOME and the rest of the disk do not.
export DEVBOX_DATA=/workspace/home
LOGS="$DEVBOX_DATA/.devbox-logs"
mkdir -p "$LOGS"
exec >>"$LOGS/start.log" 2>&1
echo "== $(date '+%F %T') $DEVBOX_NAME as $(id -un)"

# Keep your own gh login on /workspace once it is saved there.
if [ -f "$DEVBOX_DATA/.config/gh/hosts.yml" ] && [ ! -L "$HOME/.config/gh" ]; then
  mkdir -p "$HOME/.config"
  rm -rf "$HOME/.config/gh"
  ln -s "$DEVBOX_DATA/.config/gh" "$HOME/.config/gh"
fi

# Before T3 starts, so its agents inherit the git settings.
. "$DEVBOX/common/git.sh"
sh "$DEVBOX/common/t3.sh"

# Slow, and T3 does not need it to start.
setsid nohup sh -c "
  echo \"== \$(date '+%F %T') setup\"
  sh '$DEVBOX/common/browser-deps.sh'
  sh '$DEVBOX/common/dotfiles.sh'
  echo \"== \$(date '+%F %T') setup exit=\$?\"
" >>"$LOGS/setup.log" 2>&1 </dev/null &
