#!/usr/bin/env bash
#
# KiraRoom one-time Hostinger VPS bootstrap.
#
# Run this ONCE on the VPS as the initial user (root, or a user with
# sudo). It is idempotent — re-running after the first time is a no-op.
#
# What it does:
#   1. Installs Docker Engine + the compose plugin (if missing).
#   2. Creates a dedicated `kiraroom` system user. CI deploys log in as
#      this user via SSH key. The user has passwordless sudo.
#   3. Creates /opt/kiraroom/ with docker-compose.prod.yml + a fresh
#      .env.production copied from the template (operator fills in
#      real secrets afterward).
#   4. Authorises the public half of the GitHub Actions deploy SSH key.
#      Paste the key when prompted.
#   5. Installs certbot so HTTPS can be set up after first boot.
#   6. Opens firewall ports 22, 80, 443.
#
# Hostinger specifics:
#   - Ubuntu 22.04 LTS or 24.04 LTS assumed. The apt-get incantation
#     uses Docker's official repo, which works on any modern Debian.
#   - Hostinger's default firewall (`ufw`) is enabled but only allows
#     SSH by default. This script adds 80/443.
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/lagop/KiraRoom/develop/ops/deploy/bootstrap-hostinger.sh | sudo bash
#   # or
#   scp ops/deploy/bootstrap-hostinger.sh root@<VPS-IP>:/tmp/ && ssh root@<VPS-IP> 'bash /tmp/bootstrap-hostinger.sh'

set -euo pipefail

log() { echo "[bootstrap $(date -u +%H:%M:%SZ)] $*"; }
require_root() {
  if [[ "$EUID" -ne 0 ]]; then
    log "FATAL: this script must run as root (or with sudo)."
    exit 1
  fi
}

require_root

# ─────────────────────────────────────────────────────────────────────
# 1. Docker Engine + compose plugin
# ─────────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker Engine ..."
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  log "Docker installed: $(docker --version)"
else
  log "Docker already installed: $(docker --version)"
fi

# ─────────────────────────────────────────────────────────────────────
# 2. kiraroom system user
# ─────────────────────────────────────────────────────────────────────
if ! id kiraroom >/dev/null 2>&1; then
  log "Creating kiraroom user ..."
  useradd --system --shell /bin/bash --create-home --groups docker kiraroom
  echo "kiraroom ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/kiraroom
  chmod 0440 /etc/sudoers.d/kiraroom
fi

install -d -m 0700 -o kiraroom -g kiraroom /home/kiraroom/.ssh

# ─────────────────────────────────────────────────────────────────────
# 3. /opt/kiraroom/ + docker-compose.prod.yml + .env.production
# ─────────────────────────────────────────────────────────────────────
install -d -m 0755 -o kiraroom -g kiraroom /opt/kiraroom

# Pull the latest docker-compose.prod.yml from the repo. After the first
# deploy, CI will overwrite this file on every release.
if [[ ! -f /opt/kiraroom/docker-compose.prod.yml ]]; then
  log "Fetching docker-compose.prod.yml from develop ..."
  curl -fsSL \
    https://raw.githubusercontent.com/lagop/KiraRoom/develop/docker-compose.prod.yml \
    -o /opt/kiraroom/docker-compose.prod.yml
  chown kiraroom:kiraroom /opt/kiraroom/docker-compose.prod.yml
fi

if [[ ! -f /opt/kiraroom/.env.production ]]; then
  log "Creating blank /opt/kiraroom/.env.production from template ..."
  curl -fsSL \
    https://raw.githubusercontent.com/lagop/KiraRoom/develop/ops/deploy/.env.production.example \
    -o /opt/kiraroom/.env.production
  chmod 0600 /opt/kiraroom/.env.production
  chown kiraroom:kiraroom /opt/kiraroom/.env.production
  log "  >>> EDIT /opt/kiraroom/.env.production BEFORE FIRST DEPLOY <<<"
fi

# Sync the latest deploy-prod.sh into /opt/kiraroom so CI can call it.
curl -fsSL \
  https://raw.githubusercontent.com/lagop/KiraRoom/develop/ops/deploy/deploy-prod.sh \
  -o /opt/kiraroom/deploy-prod.sh
chmod +x /opt/kiraroom/deploy-prod.sh
chown kiraroom:kiraroom /opt/kiraroom/deploy-prod.sh

# ─────────────────────────────────────────────────────────────────────
# 4. GitHub Actions deploy SSH key (paste when prompted)
# ─────────────────────────────────────────────────────────────────────
AUTH_KEYS=/home/kiraroom/.ssh/authorized_keys
if [[ ! -s "${AUTH_KEYS}" ]]; then
  log "Paste the public half of the GitHub Actions deploy key."
  log "  (Generate it once:  ssh-keygen -t ed25519 -C kira-ci-deploy -f /tmp/kira-ci.key)"
  log "  Then paste the contents of /tmp/kira-ci.key.pub below."
  log "  End with Ctrl-D on an empty line."
  install -m 0600 -o kiraroom -g kiraroom /dev/null "${AUTH_KEYS}"
  while IFS= read -r line; do
    [[ -z "${line}" ]] && break
    echo "${line}" >> "${AUTH_KEYS}"
  done
fi

# ─────────────────────────────────────────────────────────────────────
# 5. certbot
# ─────────────────────────────────────────────────────────────────────
if ! command -v certbot >/dev/null 2>&1; then
  log "Installing certbot ..."
  apt-get install -y certbot
fi

# ─────────────────────────────────────────────────────────────────────
# 6. Firewall
# ─────────────────────────────────────────────────────────────────────
if command -v ufw >/dev/null 2>&1; then
  log "Opening 22/80/443 in ufw ..."
  ufw allow OpenSSH || true
  ufw allow 80/tcp || true
  ufw allow 443/tcp || true
fi

log ""
log "Bootstrap done."
log ""
log "Next steps:"
log "  1. SSH as kiraroom and edit /opt/kiraroom/.env.production:"
log "       sudo -u kiraroom -H vim /opt/kiraroom/.env.production"
log "  2. (Optional) DNS: point app/api/admin.kiraroom.net A records at $(curl -s ifconfig.me)"
log "  3. Start the stack once manually to verify:"
log "       sudo -u kiraroom -H bash /opt/kiraroom/deploy-prod.sh latest"
log "  4. After DNS resolves, enable HTTPS:"
log "       certbot --nginx -d app.kiraroom.net -d api.kiraroom.net -d admin.kiraroom.net \\"
log "                --non-interactive --agree-tos -m ops@kiraroom.net"
log "  5. Add GitHub secrets on lagop/KiraRoom:"
log "       VPS_HOST       = <this server's public IP>"
log "       VPS_USER       = kiraroom"
log "       VPS_SSH_KEY    = <contents of /tmp/kira-ci.key (private)>"
log "       APP_IMAGE_TAG  = develop (or main, depending on branch)"
log ""
log "From then on, every push to main runs deploy-prod.sh automatically."
