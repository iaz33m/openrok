#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_HOST="${OPENROCK_DEPLOY_HOST:-44.193.192.39}"
SERVER_USER="${OPENROCK_DEPLOY_USER:-ec2-user}"
SSH_KEY="${OPENROCK_SSH_KEY:-}"
REMOTE_DIR="${OPENROCK_REMOTE_DIR:-/opt/openrock}"

if [[ -z "$SSH_KEY" || ! -f "$SSH_KEY" ]]; then
  echo "Set OPENROCK_SSH_KEY to the path of the EC2 private key." >&2
  exit 1
fi

cd "$ROOT_DIR"
npm ci
npm run build:server

ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "${SERVER_USER}@${SERVER_HOST}" "sudo mkdir -p '${REMOTE_DIR}' && sudo chown '${SERVER_USER}:${SERVER_USER}' '${REMOTE_DIR}'"
rsync -az --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude .env \
  -e "ssh -i '$SSH_KEY' -o StrictHostKeyChecking=accept-new" \
  "$ROOT_DIR/" "${SERVER_USER}@${SERVER_HOST}:${REMOTE_DIR}/"

ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "${SERVER_USER}@${SERVER_HOST}" "cd '${REMOTE_DIR}' && npm ci --omit=dev --workspaces --include-workspace-root"

echo "Uploaded OpenRock to ${SERVER_USER}@${SERVER_HOST}:${REMOTE_DIR}"
echo "Next: create ${REMOTE_DIR}/.env from deploy/ec2-openrock.env.example and install deploy/openrock-server.service."
