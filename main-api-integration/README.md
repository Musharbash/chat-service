# Main API ↔ Chat backend integration (Pattern B, Express)

This folder contains the routes you add to your **main Artook Express API** to integrate with the chat backend. The chat-api itself doesn't change at runtime.

## What you're adding to the main API

Four routes:

| Route | Purpose |
|---|---|
| `POST /chat/socket-token` | Mints a chat JWT for the logged-in user, signed with the same ES256 keypair the chat-api/gateway uses. The Flutter app calls this before opening the socket. |
| `POST /chat/devices` | Proxies device registration to chat-api (with the service secret), so push tokens land in the chat backend's devices table for FCM fan-out. |
| `DELETE /chat/devices/:deviceId` | Same, but for logout / token rotation cleanup. |
| `POST /chat/upload` | Accepts multipart image/voice/file uploads, stores them, returns a public URL. Used by ChatBloc before sending media messages. |

You also need:
- A copy of `jwt.key` (the ES256 private key from `backend/jwt.key`).
- Several env vars in your main API: see [.env.additions](.env.additions).
- The npm deps `jose multer mime-types sharp`.

## Files in this folder

- [chat-routes.ts](chat-routes.ts) — token mint + device register/delete routes.
- [chat-upload-route.ts](chat-upload-route.ts) — media upload route. Stores to disk by default; swap for S3/R2 in production.
- [.env.additions](.env.additions) — env vars to add to your main API's `.env`.
- [package.json.additions](package.json.additions) — npm deps to add.

## How to mount both routers

```typescript
import { chatRoutes } from './routes/chat-routes';
import { chatUploadRoutes } from './routes/chat-upload-route';

// Order doesn't matter — both mount under /chat with non-overlapping paths.
app.use('/chat', chatRoutes);
app.use('/chat', chatUploadRoutes);
```

## Step-by-step integration

```bash
# 1. From the chat backend folder, generate a service secret
openssl rand -base64 48
# → paste the output into BOTH:
#    - backend/.env             as SERVICE_SECRET=...
#    - <your-main-api>/.env     as CHAT_SERVICE_SECRET=...
#   They MUST be identical.

# 2. Restart chat-api so it picks up SERVICE_SECRET
docker compose up -d --force-recreate api

# 3. Copy jwt.key into your main API repo (or wherever it can be mounted)
cp backend/jwt.key /path/to/your/main-api/secrets/chat-jwt.key
# Add to .gitignore — DO NOT COMMIT THIS FILE.

# 4. Install the JWT signing library in your main API
cd /path/to/your/main-api
npm install jose

# 5. Add the env vars from .env.additions to your main API's .env

# 6. Copy chat-routes.ts into your main API (adjust paths to fit your project layout)

# 7. Mount it in your main API's app entrypoint (Express app):
#       import { chatRoutes } from './routes/chat-routes';
#       app.use('/chat', chatRoutes);

# 8. Restart your main API and verify
curl -X POST http://localhost:<main-api-port>/chat/socket-token \
  -H "Authorization: Bearer <a-valid-user-bearer>" \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"test-device"}'

# Expected: { "ok": true, "token": "eyJ...", "expiresAt": ..., "userId": "..." }
```

## How auth flows after this

```
1. Flutter calls POST <main-api>/chat/socket-token with bearer
2. Main API's existing auth middleware identifies the user (req.user.id)
3. Main API mints an ES256 JWT directly using chat-jwt.key
4. Returns { ok, token, expiresAt, userId } to Flutter
5. Flutter opens Socket.IO to gateway with that token in handshake.auth
6. Gateway verifies the JWT signature with its public key, accepts the connection
```

No introspection round-trip. The chat-api's `UPSTREAM_AUTH_INTROSPECT_URL` is no longer used.

## Security notes

- `chat-jwt.key` must never leave your servers. Treat it like a database password.
- `CHAT_SERVICE_SECRET` is the highest-privilege credential in the chat system — anyone who has it can act as any user. Rotate if leaked.
- Tokens are short-lived (1 hour by default). They can't be revoked early in Pattern B — if you need that, switch to Pattern A or add a revocation list.
