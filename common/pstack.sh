#!/bin/sh
# Use the same pstack models as my own machines. /setup-pstack writes them to
# ~/.cursor/rules/pstack-models.mdc, and a Claude Code user rule says how to
# read that file. Both live in the dotfiles, so copy them from there. Without
# them pstack falls back to its defaults and runs code roles on Opus max.
set -u
BASE=https://raw.githubusercontent.com/PunGrumpy/dotfiles/${DEVBOX_DOTFILES_REF:-main}/home

# pstack reads ~/.cursor. Keep it on $DEVBOX_DATA when $HOME does not survive a
# rebuild.
if [ "$(cd "$HOME" && pwd -P)" != "$(cd "$DEVBOX_DATA" && pwd -P)" ] && [ ! -L "$HOME/.cursor" ]; then
  mkdir -p "$DEVBOX_DATA/.cursor"
  rm -rf "$HOME/.cursor"
  ln -s "$DEVBOX_DATA/.cursor" "$HOME/.cursor"
fi

fetch() {
  mkdir -p "$(dirname "$2")"
  if curl -fsSL "$BASE/$1" -o "$2.tmp"; then
    mv "$2.tmp" "$2"
  else
    rm -f "$2.tmp"
    echo "pstack: cannot read $1"
  fi
}
fetch dot_cursor/rules/pstack-models.mdc "$DEVBOX_DATA/.cursor/rules/pstack-models.mdc"
fetch dot_claude/rules/pstack.md "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/rules/pstack.md"
