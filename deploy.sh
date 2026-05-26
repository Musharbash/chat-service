#!/usr/bin/env bash
#
# One-shot deployment for the Artook chat backend.
#
# Run this every time you redeploy. The script is fully idempotent —
# existing keys, .env, and uploads are preserved across re-runs.
#
# What it does:
#   1. Generates a fresh ES256 JWT keypair on first run (never reuses
#      the dev keys from the repo — those are baked into git history).
#   2. Creates .env with strong random values for POSTGRES_PASSWORD and
#      SERVICE_SECRET (saved to ./SECRETS.txt so you can copy them to your
#      main API's env).
#   3. Creates uploads/ for chat media (images / voice / files), bound
#      into the api container at /data/chat-uploads.
#   4. Opens the firewall for gateway (4000) and api (4100).
#   5. Builds and starts all 5 services (forces a rebuild so new package.json
#      deps are picked up).
#   6. Smoke-tests both /healthz endpoints.
#
# Wipe-and-redeploy flow (drops user data + secrets, fresh start):
#   docker compose down -v
#   rm -rf /srv/artook-chat
#   mkdir -p /srv/artook-chat
#   # re-upload backend folder, then:
#   bash deploy.sh

set -euo pipefail

cd "$(dirname "$0")"

echo "==> 1/6  JWT keypair"
if [[ -f jwt.key && -f jwt.pub ]]; then
    echo "    already exists, skipping"
else
    openssl ecparam -genkey -name prime256v1 -noout -out jwt.key
    openssl ec -in jwt.key -pubout -out jwt.pub 2>/dev/null
    echo "    generated jwt.key + jwt.pub (keep these — losing jwt.key invalidates every device)"
fi
# Always re-apply: the container's node user (UID 1000) needs to read these.
# 600 would only let root read them and the api container would crash on boot
# with EACCES on /run/secrets/jwt.key.
chmod 644 jwt.key jwt.pub

echo "==> 2/6  .env + SECRETS.txt"
if [[ -f .env ]]; then
    echo "    already exists, skipping (edit it manually if you want to rotate)"
else
    POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '/=+' | cut -c1-24)
    SERVICE_SECRET=$(openssl rand -base64 48 | tr -d '\n')

    cat > .env <<EOF
POSTGRES_USER=chat
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=chat

LOG_LEVEL=info
GATEWAY_PORT=4000
API_PORT=4100

JWT_ISSUER=artook-api
JWT_AUDIENCE=artook-chat
SOCKET_TOKEN_TTL_SECONDS=3600

# Leave blank — we use Pattern B (main API mints JWT directly).
UPSTREAM_AUTH_INTROSPECT_URL=
UPSTREAM_AUTH_SHARED_SECRET=

# Main API must send this in X-Service-Secret on every chat-api call.
SERVICE_SECRET=${SERVICE_SECRET}

SOCKET_PATH=/socket.io
# Cleartext test deployment — locked to your Flutter origin once you move
# behind TLS. For now '*' is fine because the api also requires JWT/secret.
CORS_ORIGIN=*

FCM_SERVICE_ACCOUNT_JSON=
FCM_PROJECT_ID=

UNDELIVERED_TTL_DAYS=14
SWEEP_INTERVAL_SECONDS=300
EOF
    chmod 600 .env

    cat > SECRETS.txt <<EOF
# Paste these into your MAIN API's .env (the creativersion.tech server).
# Without them, the Flutter app can't mint chat tokens.

CHAT_API_BASE_URL=http://156.67.28.84:4100
CHAT_SERVICE_SECRET=${SERVICE_SECRET}
CHAT_JWT_ISSUER=artook-api
CHAT_JWT_AUDIENCE=artook-chat
CHAT_SOCKET_TOKEN_TTL_SECONDS=3600

# Also scp the chat server's jwt.key to your main API box:
#   scp root@156.67.28.84:/srv/artook-chat/jwt.key /path/on/main-api/chat-jwt.key
# Then set:
#   CHAT_JWT_PRIVATE_KEY_FILE=/path/on/main-api/chat-jwt.key

# Postgres root password (only if you need to ssh in and run psql by hand):
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
EOF
    chmod 600 SECRETS.txt
    echo "    generated .env + SECRETS.txt — open SECRETS.txt to see what to add to your main API"
fi

echo "==> 3/6  uploads directory"
if [[ ! -d uploads ]]; then
    mkdir -p uploads
    echo "    created ./uploads"
else
    echo "    already exists, keeping existing files"
fi
# 777 because the api container runs as an auto-assigned alpine system UID
# that doesn't match the host user. World-rwx on a single-tenant box is the
# pragmatic call — only ssh users can reach the host filesystem anyway.
chmod 777 uploads

echo "==> 4/6  firewall (ufw)"
if command -v ufw >/dev/null 2>&1; then
    ufw allow OpenSSH >/dev/null 2>&1 || true
    ufw allow 4000/tcp >/dev/null 2>&1 || true
    ufw allow 4100/tcp >/dev/null 2>&1 || true
    yes | ufw enable >/dev/null 2>&1 || true
    echo "    SSH + 4000 + 4100 open"
else
    echo "    ufw not installed — install with: apt install ufw"
fi

echo "==> 5/6  docker compose up -d --build"
# --build picks up package.json changes (new deps, etc) without needing a
# separate `docker compose build`. Forces a rebuild every run, which is
# slower but means re-running this script after editing source code
# actually ships the new code.
docker compose up -d --build

echo "    waiting 15s for services to settle..."
sleep 15

echo "==> 6/6  smoke test"
GATEWAY=$(curl -sf http://localhost:4000/healthz || echo FAIL)
API=$(curl -sf http://localhost:4100/healthz || echo FAIL)
echo "    gateway: $GATEWAY"
echo "    api:     $API"

if [[ "$GATEWAY" == "FAIL" || "$API" == "FAIL" ]]; then
    echo ""
    echo "Something didn't come up. Check logs:"
    echo "  docker compose ps"
    echo "  docker compose logs gateway --tail 100"
    echo "  docker compose logs api --tail 100"
    exit 1
fi

echo ""
echo "Backend is up on http://156.67.28.84:4000 (gateway) and :4100 (api)."
echo "Next: cat SECRETS.txt and paste those values into your main API."
