#!/bin/sh
# Apply github.com/PunGrumpy/dotfiles with chezmoi, and keep them up to date.
set -u
CHEZMOI="$HOME/.local/bin/chezmoi"

if [ ! -x "$CHEZMOI" ]; then
  sh -c "$(curl -fsLS get.chezmoi.io)" -- -b "$HOME/.local/bin"
fi

# Homebrew's installer and chezmoi both ask before they change files unless told not to.
export NONINTERACTIVE=1
if [ -d "$HOME/.local/share/chezmoi/.git" ]; then
  "$CHEZMOI" update --force
else
  "$CHEZMOI" init --apply --force PunGrumpy
fi
