#!/bin/sh
mkdir -p /workspace/home/.devbox-logs
exec >>/workspace/home/.devbox-logs/start.log 2>&1
echo "== $(date '+%F %T')"
DEVBOX_HOME=$(cd "$(dirname "$0")/.." && pwd)
export DEVBOX_HOME BUN_INSTALL=/workspace/home/.bun
exec sh "$DEVBOX_HOME/install.sh" up --data /workspace/home --name "upstash-${UPSTASH_BOX_NAME:-$(hostname)}" \
  ${UPSTASH_BOX_ID:+--public-url "https://$UPSTASH_BOX_ID-3773.preview.box.upstash.com"}
