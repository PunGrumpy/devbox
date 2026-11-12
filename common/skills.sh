#!/bin/sh
# Install the agent skills my dotfiles install on my own machines, for Claude
# Code and Codex. The list lives only in the dotfiles, so read it from there.
# Like chezmoi's run_onchange, it reinstalls only when the list changes.
set -u
LIST_URL=https://raw.githubusercontent.com/PunGrumpy/dotfiles/main/home/run_onchange_after_40-install-agent-skills.sh.tmpl
STAMP="$DEVBOX_DATA/.devbox-skills"

# Codex reads ~/.agents/skills. Keep it on $DEVBOX_DATA when $HOME does not
# survive a rebuild. Claude Code already follows $CLAUDE_CONFIG_DIR.
if [ "$(cd "$HOME" && pwd -P)" != "$(cd "$DEVBOX_DATA" && pwd -P)" ] && [ ! -L "$HOME/.agents" ]; then
  mkdir -p "$DEVBOX_DATA/.agents"
  rm -rf "$HOME/.agents"
  ln -s "$DEVBOX_DATA/.agents" "$HOME/.agents"
fi

# The `skill <source> [--skill <names>]` lines. Private repos go over HTTPS,
# where gh's login works; the machine has no SSH key.
list=$(curl -fsSL "$LIST_URL" | grep '^skill ' | sed 's|git@github.com:|https://github.com/|') || {
  echo "skills: cannot read the list"
  exit 0
}
sum=$(printf '%s' "$list" | sha256sum | cut -d' ' -f1)
if [ "$(cat "$STAMP" 2>/dev/null)" = "$sum" ]; then
  echo "skills: up to date"
  exit 0
fi

failed=0
# --copy: a link into a cache would not survive a rebuild.
skill() {
  (cd /tmp && npx -y skills add "$@" --global --yes --copy --agent claude-code codex </dev/null) ||
    failed=$((failed + 1))
}
eval "$list"

if [ "$failed" -eq 0 ]; then
  echo "$sum" >"$STAMP"
else
  echo "skills: $failed sources failed, trying again on the next start"
fi
