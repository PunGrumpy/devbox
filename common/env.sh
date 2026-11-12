# Source this file. Sets the environment for T3, its agents, and login shells.
#
# Git reads GIT_CONFIG_* before ~/.gitconfig, so this overrides what the
# machine image set without touching any file:
# - commit as me, not as the image's default user
# - no commit signing: the signing key lives in 1Password, which a remote
#   machine cannot reach
# - log in to github.com through gh, so git and gh share one account
# It also keeps mise and rustup data in $DEVBOX_DATA, which survives a rebuild.
env_file=$(mktemp)
cat >"$env_file" <<ENV
export GIT_CONFIG_COUNT=5
export GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=PunGrumpy
export GIT_CONFIG_KEY_1=user.email GIT_CONFIG_VALUE_1=108584943+PunGrumpy@users.noreply.github.com
export GIT_CONFIG_KEY_2=commit.gpgsign GIT_CONFIG_VALUE_2=false
export GIT_CONFIG_KEY_3=credential.https://github.com.helper GIT_CONFIG_VALUE_3=
export GIT_CONFIG_KEY_4=credential.https://github.com.helper GIT_CONFIG_VALUE_4='!gh auth git-credential'
export MISE_DATA_DIR=$DEVBOX_DATA/.local/share/mise
export RUSTUP_HOME=$DEVBOX_DATA/.rustup CARGO_HOME=$DEVBOX_DATA/.cargo
export PATH=$DEVBOX_DATA/.local/bin:$DEVBOX_DATA/.local/share/mise/shims:\$PATH
ENV
# shellcheck source=/dev/null
. "$env_file"
sudo -n install -m 644 "$env_file" /etc/profile.d/devbox.sh
rm -f "$env_file"
