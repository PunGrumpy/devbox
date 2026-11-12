# Source this file. Turns off commit signing for every git on this machine.
#
# The dotfiles sign commits with an SSH key that lives in 1Password, which a
# remote machine cannot reach, so every commit would fail. Git reads
# GIT_CONFIG_* before ~/.gitconfig, which keeps the dotfiles unchanged.
DEVBOX_GIT_ENV='export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false'

eval "$DEVBOX_GIT_ENV"
echo "$DEVBOX_GIT_ENV" | sudo -n tee /etc/profile.d/devbox-git.sh >/dev/null
sudo -n mkdir -p /etc/fish/conf.d
printf 'set -gx GIT_CONFIG_COUNT 1\nset -gx GIT_CONFIG_KEY_0 commit.gpgsign\nset -gx GIT_CONFIG_VALUE_0 false\n' |
  sudo -n tee /etc/fish/conf.d/devbox-git.fish >/dev/null
