#!/bin/sh
set -eu
repo=${DEVBOX_REPO:-https://github.com/PunGrumpy/devbox}
dir=${DEVBOX_HOME:-$HOME/.devbox}
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash >&2
if [ -d "$dir/.git" ]; then
  git -C "$dir" pull -q --ff-only >&2 || echo "devbox: pull failed, running $(git -C "$dir" rev-parse --short HEAD)" >&2
else
  git clone -q "$repo" "$dir" >&2
fi
(cd "$dir" && bun install --frozen-lockfile --production --silent) >&2

bun=$(command -v bun)
wrapper="#!/bin/sh
exec '$bun' '$dir/src/cli.ts' \"\$@\""
if [ "$(cat "$HOME/.local/bin/devbox" 2>/dev/null)" != "$wrapper" ]; then
  mkdir -p "$HOME/.local/bin"
  printf '%s\n' "$wrapper" >"$HOME/.local/bin/devbox"
  chmod 755 "$HOME/.local/bin/devbox"
fi
exec "$bun" "$dir/src/cli.ts" "$@"
