#!/bin/sh
# Install the languages the image lacks, with mise. Its data lives in
# $DEVBOX_DATA, so a rebuilt machine keeps them.
set -u
MISE="$DEVBOX_DATA/.local/bin/mise"

if [ ! -x "$MISE" ]; then
  curl -fsSL https://mise.run | MISE_INSTALL_PATH="$MISE" sh
fi

# Languages for every project. A project's own mise.toml or .tool-versions
# can ask for more: run `mise install` in it.
"$MISE" use --global --yes go@latest rust@latest
