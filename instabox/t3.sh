#!/bin/sh
# Update T3 Code to the newest release on the Mac's channel. t3-instabox.service
# runs this before every start (see setup.sh). instabox installs its own T3 in
# /usr/local/bin, but its start script puts ~/.local/bin first on PATH, so the
# copy installed here wins and instabox's own stays untouched.
set -u

channel="${DEVBOX_T3_CHANNEL:-nightly}"
want=$(npm view "t3@$channel" version 2>/dev/null)
have=$("$HOME/.local/bin/t3" --version 2>/dev/null | sed 's/^t3 v//')
if [ -n "$want" ] && [ "$want" != "$have" ]; then
  echo "t3: ${have:-none} -> $want ($channel)"
  npm install -g --prefix "$HOME/.local" "t3@$want"
fi
