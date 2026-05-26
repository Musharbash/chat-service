# Production deployment guide — Artook chat backend

End-to-end checklist for getting the chat backend running on your production server, integrated with your existing main Artook API, and shippable in a release APK.

---

## 1. Server requirements

Minimum spec to start (handles up to ~5k concurrent users comfortably):

- 1 vCPU, 2 GB RAM, 20 GB SSD
- Ubuntu 22.04 LTS (or any Linux with Docker support)
- Open ports: 80, 443, 22

Recommended providers: Hetzner CX22 (~€4/mo), DigitalOcean Basic Droplet ($6/mo), Linode Nanode ($5/mo).

```bash
# SSH into the server
ssh root@your-server-ip

# Install Docker + Docker Compose (Ubuntu)
curl -fsSL https://get.docker.com | sh
apt install -y docker-compose-plugin

# Verify
docker --version
docker compose version
```

---

## 2. DNS setup

Point a subdomain at the server:

| Record | Type | Value |
|---|---|---|
| `chat.creativersion.tech` | A | your-server-ip |

Wait ~5 minutes for propagation. Verify:
```bash
dig chat.creativersion.tech +short
# Should return your server IP
```

---

## 3. TLS via Caddy (recommended — handles certs automatically)

Caddy auto-provisions Let's Encrypt certs. No nginx config wrestling.

Create `/srv/artook-chat/Caddyfile`:
```
chat.creativersion.tech {
    # Socket.IO needs websocket upgrade + sticky sessions
    reverse_proxy gateway:4000

    # Health endpoint for uptime monitoring
    @health path /healthz /readyz
    handle @health {
        reverse_proxy gateway:4000
    }

    encode gzip zstd
    log {
        output file /data/access.log
        format json
    }
}
```

If you want the REST API on a separate subdomain (cleaner):
```
api-chat.creativersion.tech {
    reverse_proxy api:4100
}
```
Otherwise leave it on the same domain (api uses different port internally).

---

## 4. Deploy the backend

```bash
# On your server
mkdir -p /srv/artook-chat && cd /srv/artook-chat

# Copy your repo's backend folder here. Options:
#   a) git clone the whole repo
#   b) scp -r backend/ root@server:/srv/artook-chat/
#   c) docker registry push from CI

# Generate the production keypair
openssl ecparam -genkey -name prime256v1 -noout -out jwt.key
openssl ec -in jwt.key -pubout -out jwt.pub
chmod 600 jwt.key  # the gateway only needs the public key but the api needs both

# Generate the service secret (one-time, KEEP THIS SAFE)
openssl rand -base64 48
# Copy this value — you'll paste it into BOTH this server's .env AND your main API's .env

# Create .env (see §5 for full content)
cp .env.example .env
vim .env
```

Add Caddy to the compose stack. Edit `docker-compose.yml` and add:

```yaml
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - chatnet
    depends_on:
      - gateway

volumes:
  redis_data:
  postgres_data:
  caddy_data:
  caddy_config:
```

Also **remove the `ports:` mapping from gateway and api services** — Caddy proxies them, they shouldn't be publicly exposed:

```yaml
gateway:
  # ports:                              # ← remove this block
  #   - "${GATEWAY_PORT:-4000}:4000"
api:
  # ports:                              # ← remove this block
  #   - "${API_PORT:-4100}:4100"
```

Then boot:
```bash
docker compose up -d --build
docker compose ps  # all 6 services should be Up + Healthy
docker compose logs --tail 50
```

Verify TLS works:
```bash
curl https://chat.creativersion.tech/healthz
# → {"ok":true,"svc":"gateway"}
```

If Caddy fails to get a cert, check:
- DNS is propagated
- Port 80 is open (Let's Encrypt's challenge uses it)
- `docker compose logs caddy`

---

## 5. Production .env

```bash
# /srv/artook-chat/.env

POSTGRES_USER=chat
POSTGRES_PASSWORD=<STRONG_RANDOM_HERE>  # generate with `openssl rand -base64 24`
POSTGRES_DB=chat

LOG_LEVEL=info

# These ports are internal-only when Caddy fronts everything.
GATEWAY_PORT=4000
API_PORT=4100

JWT_ISSUER=artook-api
JWT_AUDIENCE=artook-chat
SOCKET_TOKEN_TTL_SECONDS=3600

# Leave these BLANK if you're using Pattern B (main API mints tokens directly).
UPSTREAM_AUTH_INTROSPECT_URL=
UPSTREAM_AUTH_SHARED_SECRET=

# Same value MUST be set as CHAT_SERVICE_SECRET in your main API .env
SERVICE_SECRET=<paste the openssl rand -base64 48 output here>

SOCKET_PATH=/socket.io
CORS_ORIGIN=https://artook.creativersion.tech  # your main app domain, not *

# FCM — fill in if you want backend-driven push for offline users
FCM_SERVICE_ACCOUNT_JSON=
FCM_PROJECT_ID=

UNDELIVERED_TTL_DAYS=14
SWEEP_INTERVAL_SECONDS=300
```

> **Important:** never commit `.env` or `jwt.key` to git. Add to `.gitignore` if you haven't already.

---

## 6. Main Artook API integration

You've already done this locally per `backend/main-api-integration/README.md`. For production:

```bash
# On your main API server (assuming it's separate; if same machine, same path)
cd /path/to/your/main-api

# Copy the keypair from the chat server (the main API needs the PRIVATE key to mint)
scp root@chat-server:/srv/artook-chat/jwt.key ./secrets/chat-jwt.key
chmod 600 ./secrets/chat-jwt.key
```

Add to main API's production `.env`:
```bash
CHAT_JWT_PRIVATE_KEY_FILE=/path/to/secrets/chat-jwt.key
# Internal URL: if same docker network, use service name; if separate machine, use full hostname
CHAT_API_BASE_URL=https://chat.creativersion.tech    # or http://chat-api:4100 in-cluster
CHAT_SERVICE_SECRET=<the same secret you put in chat backend's .env>
CHAT_JWT_ISSUER=artook-api
CHAT_JWT_AUDIENCE=artook-chat
CHAT_SOCKET_TOKEN_TTL_SECONDS=3600
```

Install the dep + mount the routes (per `backend/main-api-integration/chat-routes.ts`):
```bash
cd /path/to/your/main-api
npm install jose
# Restart the main API process
```

Verify:
```bash
# From any logged-in client (Postman, curl with a real bearer):
curl -X POST https://api.creativersion.tech/chat/socket-token \
  -H "Authorization: Bearer <real-user-token>" \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"production-test-1"}'

# Expected: { "ok": true, "token": "eyJ...", "expiresAt": ..., "userId": "..." }
```

---

## 7. Media uploads (image / voice / file)

The chat backend **does not host media itself**. Media flows like this:

```
Flutter ──upload──► main API /chat/upload ──store──► your storage (S3/R2/disk)
                            │
                            └── returns { url, width, height, bytes, mime }
                                                  │
Flutter ──message:send──► gateway ──message:new──► recipient
   body: { type: 'image', url: '<remote URL>' }
```

You need three things:

### 7a. A storage location

Pick one — they all work:

| Option | Best for | Pros | Cons |
|---|---|---|---|
| AWS S3 / Cloudflare R2 | Production | Cheap, fast, CDN | Setup overhead |
| Local disk + Caddy file_server | MVP | Zero setup | Doesn't scale, no backup |
| Your existing image storage | If you already host user avatars | Reuse infra | Possibly limited to images |

For MVP, **local disk on the main API server** is the fastest path. Files saved to `./uploads/chat/{userId}/{ulid}.{ext}`, served at `https://api.creativersion.tech/uploads/...`.

### 7b. Main API upload endpoint

Add a new Express route. Template provided at `backend/main-api-integration/chat-upload-route.ts` (created in this same PR).

The route:
- Accepts `multipart/form-data` POST `/chat/upload`
- Requires the user's existing bearer auth
- Validates size + mime
- Stores file to disk (or S3)
- Returns `{ ok: true, url, width, height, bytes, mime, durationMs }`

### 7c. Flutter `ChatUploadService`

Created in this PR at `lib/features/chat/data/service/chat_upload_service.dart`. It POSTs `multipart/form-data` to `/chat/upload` on your main API and returns the remote URL.

The ChatBloc image/voice handlers were updated to upload first, then send the resulting URL in the message body. **No more local-path-in-URL hack.**

---

## 8. Build the production APK

The dev-mode dart-defines (`CHAT_DIRECT_API_URL`, `CHAT_DEV_SERVICE_SECRET`) are **forbidden in release builds** — `ChatTokenService` throws if it sees them. Production builds use the main API path, which is what you want.

```powershell
# In your project root
flutter build apk --release --flavor prod --split-per-abi
# or for a universal APK:
flutter build apk --release --flavor prod

# Or for the Play Store:
flutter build appbundle --release --flavor prod
```

The output lands in `build/app/outputs/flutter-apk/`. Install on a real device:
```powershell
adb install build/app/outputs/flutter-apk/app-prod-arm64-v8a-release.apk
```

The gateway URL is picked up from `AppManagerEnvHelper.chatGatewayUrl` for the `prod` flavor — verify that's `https://chat.creativersion.tech` in `lib/core/app/app_manager_env.dart`.

If you want to install both dev + prod side-by-side for comparison, they have different `applicationId`s (com.bcs.art.art_app vs com.creativersion.app.artook) — Android treats them as separate apps.

---

## 9. Production readiness checklist

| Item | How to verify |
|---|---|
| All services healthy | `docker compose ps` shows all "healthy" |
| TLS valid | `curl -I https://chat.creativersion.tech/healthz` returns 200 |
| Token mint works | curl test in §6 returns ok |
| Logs are flowing | `docker compose logs gateway --tail 100 -f` |
| Auto-restart on reboot | `systemctl enable docker`; compose uses `restart: unless-stopped` |
| Backups | `pg_dump` and Redis RDB snapshots, sync to S3 |
| Firewall | `ufw allow 22,80,443/tcp && ufw enable` |
| FCM working (if enabled) | Send a message to a logged-out user, watch worker logs for push attempt |

---

## 10. Scaling beyond ~5k concurrent users

When the single gateway box can't keep up:

1. Run 2-N gateway replicas behind the same Caddy reverse_proxy with `lb_policy least_conn`.
2. Redis adapter (already configured in `gateway/src/index.ts`) handles cross-replica fan-out automatically.
3. Move Postgres to a managed service (RDS, Supabase, Neon) — leave Redis on a node close to the gateways.
4. Add Caddy session affinity if WebSocket handshakes start failing — `lb_policy ip_hash`.

You probably don't need this for a long time. Real measurements first, scale second.

---

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `connection refused` from Flutter | Caddy down / DNS not propagated | `docker compose ps` + `dig chat...` |
| `unauthorized` on `/chat/socket-token` | Main API can't find the JWT private key | Check `CHAT_JWT_PRIVATE_KEY_FILE` path |
| Messages don't deliver | `SERVICE_SECRET` mismatch between main API + chat-api | Re-check both .env files |
| FCM silent | `FCM_SERVICE_ACCOUNT_JSON` blank or malformed | `docker compose logs worker \| grep FCM` |
| TLS cert renewal failed | Port 80 blocked | Open port 80 even if you redirect to 443 |
