#!/bin/sh
# Start the T3 Code server, named $DEVBOX_NAME, with its data in $DEVBOX_DATA/.t3.
set -u

# T3 Code names the environment after PRETTY_HOSTNAME before the hostname. In a
# container the hostname is a random id that cannot be changed.
echo "PRETTY_HOSTNAME=$DEVBOX_NAME" | sudo -n tee /etc/machine-info >/dev/null

if ! command -v t3 >/dev/null 2>&1; then
  sudo -n npm install -g t3
fi

# Chrome's sandbox needs user namespaces. Containers often block them (no
# AppArmor, seccomp), and then T3 runs Chrome with --no-sandbox, so the
# machine itself is the isolation boundary.
if unshare -Ur true 2>/dev/null; then sandbox=1; else sandbox=0; fi
echo "t3: browser sandbox=$sandbox"

T3CODE_SERVER_BROWSER_SANDBOX=$sandbox setsid nohup t3 serve --host 0.0.0.0 --port 3773 \
  --base-dir "$DEVBOX_DATA/.t3" >/tmp/t3.log 2>&1 </dev/null &
