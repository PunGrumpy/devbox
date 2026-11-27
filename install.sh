#!/bin/sh
set -eu
repo=${DEVBOX_REPO:-https://github.com/PunGrumpy/devbox}
dir=${DEVBOX_HOME:-$HOME/.devbox}
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

have() { command -v "$1" >/dev/null 2>&1; }
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }

if ! have bun; then
  # bun's installer unpacks a zip and stops with "unzip is required" when there is none.
  if ! have unzip; then
    if have apt-get && { [ "$(id -u)" = 0 ] || sudo -n true >/dev/null 2>&1; }; then
      echo "devbox: installing unzip with apt-get" >&2
      as_root apt-get update -qq >&2
      as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends unzip >&2
    elif have apt-get; then
      echo "devbox: unzip is required to install bun. Ask an admin to run: sudo apt-get install -y unzip" >&2
      exit 1
    else
      echo "devbox: unzip is required to install bun. Ask an admin to install the unzip package with this machine's package manager." >&2
      exit 1
    fi
  fi
  curl -fsSL https://bun.sh/install | bash >&2
fi
if [ -d "$dir/.git" ]; then
  git -C "$dir" pull -q --ff-only >&2 || echo "devbox: pull failed, running $(git -C "$dir" rev-parse --short HEAD)" >&2
else
  git clone -q "$repo" "$dir" >&2
fi
# Only the CLI. The hub page has its own, much larger, dependencies, which `devbox up --hub` installs.
(cd "$dir" && bun install --frozen-lockfile --production --filter devbox --silent) >&2

bun=$(command -v bun)
wrapper="#!/bin/sh
exec '$bun' '$dir/apps/cli/src/cli.ts' \"\$@\""
if [ "$(cat "$HOME/.local/bin/devbox" 2>/dev/null)" != "$wrapper" ]; then
  mkdir -p "$HOME/.local/bin"
  printf '%s\n' "$wrapper" >"$HOME/.local/bin/devbox"
  chmod 755 "$HOME/.local/bin/devbox"
fi
exec "$bun" "$dir/apps/cli/src/cli.ts" "$@"
