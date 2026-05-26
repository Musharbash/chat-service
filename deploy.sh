#!/usr/bin/env bash
#
# One-shot deployment for the Artook chat backend.
#
# Run this ONCE on the server. Subsequent updates use:
#   docker compose pull && docker compose up -d --build
#
# What it does:
#   1. Generates a fresh ES256 JWT keypair (never reuses the dev keys from
#      the repo — those are baked into git history).
#   2. Creates .env with strong random values for POSTGRES_PASSWORD and
#      SERVICE_SECRET (saved to ./SECRETS.txt so you can copy them to your
#      main API's env).
#   3. Opens the firewall for gateway (4000) and api (4100).
#   4. Builds and starts all 5 services.
#   5. Smoke-tests both /healthz endpoints.
#
# Safe to re-run. Existing keys/.env are left alone; only missing pieces
# are generated.

set -euo pipefail

cd "$(dirname "$0")"

echo "==> 1/5  JWT keypair"
if [[ -f jwt.key && -f jwt.pub ]]; then
    echo "    already exists, skipping"
else
    openssl ecparam -genkey -name prime256v1 -noout -out jwt.key
    openssl ec -in jwt.key -pubout -out jwt.pub 2>/dev/null
    chmod 600 jwt.key
    echo "    generated jwt.key + jwt.pub (keep these — losing jwt.key invalidates every device)"
fi

echo "==> 2/5  .env + SECRETS.txt"
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

echo "==> 3/5  firewall (ufw)"
if command -v ufw >/dev/null 2>&1; then
    ufw allow OpenSSH >/dev/null 2>&1 || true
    ufw allow 4000/tcp >/dev/null 2>&1 || true
    ufw allow 4100/tcp >/dev/null 2>&1 || true
    yes | ufw enable >/dev/null 2>&1 || true
    echo "    SSH + 4000 + 4100 open"
else
    echo "    ufw not installed — install with: apt install ufw"
fi

echo "==> 4/5  docker compose up -d --build"
docker compose up -d --build

echo "    waiting 15s for services to settle..."
sleep 15

echo "==> 5/5  smoke test"
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
