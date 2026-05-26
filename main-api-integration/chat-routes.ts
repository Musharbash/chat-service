// Drop-in Express router for the main Artook API.
//
// Mount it like:
//   import { chatRoutes } from './routes/chat-routes';
//   app.use('/chat', chatRoutes);
//
// Requires three env vars on the main API:
//   CHAT_JWT_PRIVATE_KEY_FILE — path to the ES256 private key (same as backend/jwt.key)
//   CHAT_API_BASE_URL         — e.g. http://chat-api:4100 (internal) or http://localhost:4100 (dev)
//   CHAT_SERVICE_SECRET       — must match SERVICE_SECRET in the chat-api .env
//
// Replaces the legacy /chat/agora-token endpoint.

import { Router, Request, Response, NextFunction } from 'express';
import { createPrivateKey, KeyObject } from 'crypto';
import { readFileSync } from 'fs';
import { SignJWT } from 'jose';

// ---------------------------------------------------------------------------
// Config + signing key (loaded once at module init)
// ---------------------------------------------------------------------------

const JWT_PRIVATE_KEY_FILE = process.env.CHAT_JWT_PRIVATE_KEY_FILE;
const CHAT_API_BASE_URL = process.env.CHAT_API_BASE_URL ?? 'http://chat-api:4100';
const CHAT_SERVICE_SECRET = process.env.CHAT_SERVICE_SECRET;
const JWT_ISSUER = process.env.CHAT_JWT_ISSUER ?? 'artook-api';
const JWT_AUDIENCE = process.env.CHAT_JWT_AUDIENCE ?? 'artook-chat';
const SOCKET_TOKEN_TTL_SECONDS = Number(process.env.CHAT_SOCKET_TOKEN_TTL_SECONDS ?? 3600);

if (!JWT_PRIVATE_KEY_FILE) {
  throw new Error('CHAT_JWT_PRIVATE_KEY_FILE env var is required');
}
if (!CHAT_SERVICE_SECRET) {
  throw new Error('CHAT_SERVICE_SECRET env var is required');
}

let signingKey: KeyObject;
try {
  const pem = readFileSync(JWT_PRIVATE_KEY_FILE, 'utf8');
  signingKey = createPrivateKey(pem);
} catch (err) {
  throw new Error(`Failed to load chat JWT key from ${JWT_PRIVATE_KEY_FILE}: ${(err as Error).message}`);
}

// ---------------------------------------------------------------------------
// Auth middleware shim
// ---------------------------------------------------------------------------
//
// REPLACE THIS with your project's actual auth middleware. The contract is:
// after it runs, req.user.id (string) is the authenticated user's id.
//
// If your existing middleware sets a different field (e.g. req.auth.userId,
// req.session.user.id), adjust `getUserId` below.

interface AuthedRequest extends Request {
  user?: { id: string };
}

function getUserId(req: AuthedRequest): string | null {
  // EDIT THIS to match your project's auth setup.
  return req.user?.id ?? null;
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  // If your auth middleware is already mounted globally, this is a no-op pass.
  // Otherwise, plug it in here:
  //   yourExistingAuthMiddleware(req, res, next);
  // For now, just verify req.user is populated:
  if (!getUserId(req)) {
    res.status(401).json({ ok: false, code: 'unauthorized' });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const chatRoutes = Router();

/**
 * POST /chat/socket-token
 *
 * Body: { deviceId: string }
 * Auth: standard user bearer (handled by requireAuth)
 *
 * Mints a chat-gateway JWT for the authenticated user, valid for 1 hour.
 */
chatRoutes.post('/socket-token', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ ok: false, code: 'unauthorized' });
    return;
  }

  const deviceId = (req.body?.deviceId ?? '').toString().trim();
  if (!deviceId || deviceId.length > 128) {
    res.status(400).json({ ok: false, code: 'bad_request', message: 'deviceId required' });
    return;
  }

  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const exp = nowSec + SOCKET_TOKEN_TTL_SECONDS;
    const token = await new SignJWT({ deviceId })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(userId)
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setIssuedAt(nowSec)
      .setExpirationTime(exp)
      .sign(signingKey);
    res.json({ ok: true, token, expiresAt: exp, userId });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('chat socket-token mint failed:', err);
    res.status(500).json({ ok: false, code: 'mint_failed' });
  }
});

/**
 * POST /chat/devices
 *
 * Body: { deviceId, platform: 'ios'|'android'|'web', pushToken?, appVersion? }
 * Auth: standard user bearer
 *
 * Proxies device registration to the chat-api using the service-to-service secret.
 */
chatRoutes.post('/devices', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ ok: false, code: 'unauthorized' });
    return;
  }

  try {
    const upstreamRes = await fetch(`${CHAT_API_BASE_URL}/v1/devices`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-service-secret': CHAT_SERVICE_SECRET!,
      },
      body: JSON.stringify({ ...req.body, userId }),
    });
    const text = await upstreamRes.text();
    res.status(upstreamRes.status).type(upstreamRes.headers.get('content-type') ?? 'application/json').send(text);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('chat-api proxy failed:', err);
    res.status(502).json({ ok: false, code: 'upstream_unavailable' });
  }
});

/**
 * DELETE /chat/devices/:deviceId
 *
 * Auth: standard user bearer
 *
 * Logout / token-rotation cleanup. Proxies to chat-api.
 */
chatRoutes.delete('/devices/:deviceId', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ ok: false, code: 'unauthorized' });
    return;
  }

  try {
    const upstreamRes = await fetch(
      `${CHAT_API_BASE_URL}/v1/devices/${encodeURIComponent(req.params.deviceId)}`,
      {
        method: 'DELETE',
        headers: {
          'content-type': 'application/json',
          'x-service-secret': CHAT_SERVICE_SECRET!,
        },
        body: JSON.stringify({ userId }),
      },
    );
    const text = await upstreamRes.text();
    res.status(upstreamRes.status).type(upstreamRes.headers.get('content-type') ?? 'application/json').send(text);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('chat-api proxy failed:', err);
    res.status(502).json({ ok: false, code: 'upstream_unavailable' });
  }
});
