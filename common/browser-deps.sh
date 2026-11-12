#!/bin/sh
# Install what `t3 browser setup` installs, minus its AppArmor step, which a
# container cannot do. Debian and Ubuntu only.
set -u
command -v apt-get >/dev/null 2>&1 || exit 0

PKGS="libnss3 libglib2.0-0 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libdbus-1-3 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libxkbcommon0 libgbm1 libasound2 libexpat1 fontconfig fonts-liberation"
# shellcheck disable=SC2086 # word splitting is intended
if ! dpkg -s $PKGS >/dev/null 2>&1; then
  sudo -n apt-get update -qq &&
    sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $PKGS
fi
