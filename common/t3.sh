#!/bin/sh
# Start the T3 Code server, named $DEVBOX_NAME, with its data in $DEVBOX_DATA/.t3.
# It listens on $DEVBOX_T3_HOST:$DEVBOX_T3_PORT (default 0.0.0.0:3773).
set -u

# T3 Code names the environment after PRETTY_HOSTNAME before the hostname. In a
# container the hostname is a random id that cannot be changed.
echo "PRETTY_HOSTNAME=$DEVBOX_NAME" | sudo -n tee /etc/machine-info >/dev/null

# Follow the same release channel as the Mac, and update to its newest
# release on every start. The npm dist-tags match T3's channels.
channel="${DEVBOX_T3_CHANNEL:-nightly}"
want=$(npm view "t3@$channel" version 2>/dev/null)
have=$(t3 --version 2>/dev/null | sed 's/^t3 v//')
if [ -n "$want" ] && [ "$want" != "$have" ]; then
  echo "t3: ${have:-none} -> $want ($channel)"
  sudo -n npm install -g "t3@$want"
fi

# Chrome's sandbox needs user namespaces. Containers often block them (no
# AppArmor, seccomp), and then T3 runs Chrome with --no-sandbox, so the
# machine itself is the isolation boundary.
if unshare -Ur true 2>/dev/null; then sandbox=1; else sandbox=0; fi
echo "t3: browser sandbox=$sandbox"

T3CODE_SERVER_BROWSER_SANDBOX=$sandbox setsid nohup t3 serve --host "${DEVBOX_T3_HOST:-0.0.0.0}" --port "${DEVBOX_T3_PORT:-3773}" \
  --base-dir "$DEVBOX_DATA/.t3" >/tmp/t3.log 2>&1 </dev/null &
