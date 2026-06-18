#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  OSIRIS — one-shot install: Docker engine + Compose, then bring
#  the full stack up. Run with root:  sudo bash scripts/install-docker-and-up.sh
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

PROJECT_DIR="/home/lab/osiris"
RUN_USER="lab"

echo "═══ [1/5] Installing Docker engine + Compose plugin ═══"
if ! command -v docker >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y docker.io docker-compose-v2
else
  echo "docker already installed: $(docker --version)"
fi

echo "═══ [2/5] Enabling + starting the Docker daemon ═══"
systemctl enable --now docker
systemctl is-active --quiet docker && echo "docker daemon: active"

echo "═══ [3/5] Adding '$RUN_USER' to the docker group (effective next login) ═══"
getent group docker >/dev/null || groupadd docker
usermod -aG docker "$RUN_USER" || true

echo "═══ [4/5] Bringing up the OSIRIS stack (this builds images — may take a while) ═══"
cd "$PROJECT_DIR"
# Pull the prebuilt app image if available; fall back to local build.
docker compose pull --ignore-pull-failures || true
docker compose up -d --build

echo "═══ [5/5] Status ═══"
docker compose ps
LAN_IP=$(hostname -I | awk '{print $1}')
echo ""
echo "✅ OSIRIS is up. Access from any computer on the LAN:"
echo "   → http://${LAN_IP}:3000      (app)"
echo "   → http://${LAN_IP}:8080      (nginx cache)"
echo "   Default login: admin / admin123  (change after first login)"
