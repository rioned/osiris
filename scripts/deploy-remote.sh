#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  OSIRIS — Remote Deploy Script
#  Deploys latest code to Parrot OS PC (192.168.0.123)
#  Usage: ./scripts/deploy-remote.sh
# ═══════════════════════════════════════════════════════════════
set -e

REMOTE_IP="192.168.0.123"
REMOTE_USER="parrot"
REMOTE_PASS="701bsm2"
REMOTE_DIR="~/osiris"
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15"

echo "[1/5] Testing connection to ${REMOTE_USER}@${REMOTE_IP}..."
sshpass -p "${REMOTE_PASS}" ssh ${SSH_OPTS} "${REMOTE_USER}@${REMOTE_IP}" "hostname && uptime"
echo "  ✓ Connected"

echo "[2/5] Pushing source files to remote..."
sshpass -p "${REMOTE_PASS}" ssh ${SSH_OPTS} "${REMOTE_USER}@${REMOTE_IP}" "mkdir -p ${REMOTE_DIR}/src/app/api/connectors"
bash -c "sshpass -p '${REMOTE_PASS}' ssh ${SSH_OPTS} \"${REMOTE_USER}@${REMOTE_IP}\" \"cat > ${REMOTE_DIR}/src/app/api/connectors/route.ts\" < src/app/api/connectors/route.ts"
bash -c "sshpass -p '${REMOTE_PASS}' ssh ${SSH_OPTS} \"${REMOTE_USER}@${REMOTE_IP}\" \"cat > ${REMOTE_DIR}/src/components/AdminPanel.tsx\" < src/components/AdminPanel.tsx"
echo "  ✓ Source files copied"

echo "[3/5] Rebuilding Next.js on remote..."
sshpass -p "${REMOTE_PASS}" ssh ${SSH_OPTS} "${REMOTE_USER}@${REMOTE_IP}" \
  "cd ${REMOTE_DIR} && npm install --silent 2>&1 | tail -3 && npx next build 2>&1 | tail -10"
echo "  ✓ Next.js build complete"

echo "[4/5] Rebuilding Docker image..."
sshpass -p "${REMOTE_PASS}" ssh ${SSH_OPTS} "${REMOTE_USER}@${REMOTE_IP}" \
  "cd ${REMOTE_DIR} && docker build -t ghcr.io/aiacos/osiris:latest . 2>&1 | tail -10"
echo "  ✓ Docker image built"

echo "[5/5] Restarting service..."
sshpass -p "${REMOTE_PASS}" ssh ${SSH_OPTS} "${REMOTE_USER}@${REMOTE_IP}" \
  "cd ${REMOTE_DIR} && docker compose up -d osiris 2>&1 | tail -5"
echo "  ✓ Service restarted"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  DEPLOY COMPLETE — Social Media Connector Suite Live"
echo "  http://${REMOTE_IP}:3000"
echo "═══════════════════════════════════════════════════════"
