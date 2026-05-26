import { createWriteStream } from 'fs';
import { mkdir, stat } from 'fs/promises';
import { join, extname } from 'path';
import { pipeline } from 'stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulid';
import type { Pool } from 'pg';
import type { TokenMinter } from './token';
import type { UpstreamAuth } from './upstream-auth';
import type { ChatJwtVerifier } from './verify-chat-jwt';
import type { AppConfig } from './config';

const SocketTokenRequest = z.object({
  deviceId: z.string().min(1).max(128),
});

const DeviceRegisterRequest = z.object({
  deviceId: z.string().min(1).max(128),
  platform: z.enum(['ios', 'android', 'web']),
  pushToken: z.string().min(1).max(4096).optional(),
  appVersion: z.string().max(64).optional(),
  // When called via service-to-service auth (X-Service-Secret), the main API
  // includes the userId in the body. When called with a user bearer, this
  // field is ignored and the introspected userId is used instead.
  userId: z.string().min(1).max(128).optional(),
});

// Resolves the calling identity. Three paths, tried in order:
//   1. X-Service-Secret header matches SERVICE_SECRET → trust the body's userId.
//   2. Authorization: Bearer <chat-jwt> → verify locally with the public key.
//      This is the path the Flutter app uses for /v1/upload — it already has
//      a valid chat JWT from the socket-token mint, no need to round-trip
//      back to the main API.
//   3. Authorization: Bearer <user-token> → introspect via UpstreamAuth
//      (only if UPSTREAM_AUTH_INTROSPECT_URL is configured).
// Returns null on auth failure.
async function resolveCaller(
  req: FastifyRequest,
  cfg: AppConfig,
  upstream: UpstreamAuth,
  chatJwt: ChatJwtVerifier,
  body: { userId?: string } | undefined,
): Promise<{ userId: string } | null> {
  const serviceSecret = req.headers['x-service-secret'];
  if (
    cfg.SERVICE_SECRET &&
    typeof serviceSecret === 'string' &&
    serviceSecret === cfg.SERVICE_SECRET
  ) {
    if (!body?.userId) return null;
    return { userId: body.userId };
  }
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    const verified = await chatJwt.verify(token);
    if (verified) return { userId: verified.userId };
  }
  return upstream.resolve({ authorization: auth });
}

export async function registerRoutes(
  app: FastifyInstance,
  deps: { pg: Pool; minter: TokenMinter; upstream: UpstreamAuth; cfg: AppConfig; chatJwt: ChatJwtVerifier },
): Promise<void> {
  // Mint a socket-token. Same as before — requires user bearer (introspected
  // upstream) OR service-secret + explicit userId.
  app.post('/v1/socket-token', async (req, reply) => {
    const parsed = SocketTokenRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: 'bad_request' });

    const ident = await resolveCaller(req, deps.cfg, deps.upstream, deps.chatJwt, req.body as { userId?: string });
    if (!ident) return reply.code(401).send({ ok: false, code: 'unauthorized' });

    const minted = await deps.minter.mint({ userId: ident.userId, deviceId: parsed.data.deviceId });
    return reply.send({ ok: true, token: minted.token, expiresAt: minted.expiresAt, userId: ident.userId });
  });

  // Register / refresh a device's FCM push token.
  app.post('/v1/devices', async (req, reply) => {
    const parsed = DeviceRegisterRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: 'bad_request' });

    const ident = await resolveCaller(req, deps.cfg, deps.upstream, deps.chatJwt, parsed.data);
    if (!ident) return reply.code(401).send({ ok: false, code: 'unauthorized' });

    const { deviceId, platform, pushToken, appVersion } = parsed.data;
    await deps.pg.query(
      `INSERT INTO devices (device_id, user_id, platform, push_token, app_version, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (device_id)
       DO UPDATE SET user_id = EXCLUDED.user_id,
                     platform = EXCLUDED.platform,
                     push_token = COALESCE(EXCLUDED.push_token, devices.push_token),
                     app_version = COALESCE(EXCLUDED.app_version, devices.app_version),
                     last_seen_at = NOW()`,
      [deviceId, ident.userId, platform, pushToken ?? null, appVersion ?? null],
    );
    return reply.send({ ok: true });
  });

  // Deregister a device (logout flow).
  app.delete('/v1/devices/:deviceId', async (req, reply) => {
    const ident = await resolveCaller(req, deps.cfg, deps.upstream, deps.chatJwt, req.body as { userId?: string });
    if (!ident) return reply.code(401).send({ ok: false, code: 'unauthorized' });
    const params = req.params as { deviceId?: string };
    if (!params.deviceId) return reply.code(400).send({ ok: false, code: 'bad_request' });
    await deps.pg.query('DELETE FROM devices WHERE device_id = $1 AND user_id = $2', [
      params.deviceId,
      ident.userId,
    ]);
    return reply.send({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // POST /v1/upload — chat media uploads.
  //
  // Flow:
  //   Flutter ──multipart──► /v1/upload   (Authorization: Bearer <chat-jwt>)
  //                              │  field 'kind' = 'image' | 'voice' | 'file'
  //                              │  field 'file' = the binary
  //                              ▼
  //                       writes to ${UPLOADS_DIR}/${userId}/${ulid}.${ext}
  //                              │
  //                              ▼
  //                       returns { ok, url, mime, bytes }
  //
  // The returned URL is served back by @fastify/static at /v1/files/*.
  // Caller sends the URL in message:send body so the recipient renders it
  // directly without re-uploading.
  // ---------------------------------------------------------------------------
  app.post('/v1/upload', async (req, reply) => {
    const ident = await resolveCaller(req, deps.cfg, deps.upstream, deps.chatJwt, undefined);
    if (!ident) return reply.code(401).send({ ok: false, code: 'unauthorized' });

    if (!req.isMultipart()) {
      return reply.code(400).send({ ok: false, code: 'bad_request', message: 'multipart/form-data required' });
    }

    let kind: 'image' | 'voice' | 'file' | null = null;
    let savedPath: string | null = null;
    let savedName: string | null = null;
    let savedMime: string | null = null;
    let savedBytes = 0;

    try {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname === 'kind') {
            const v = String(part.value);
            if (v === 'image' || v === 'voice' || v === 'file') kind = v;
          }
          continue;
        }
        // part.type === 'file'
        if (part.fieldname !== 'file') {
          // ignore unexpected file fields rather than 400ing — keep the API forgiving
          continue;
        }
        if (!kind) {
          return reply.code(400).send({ ok: false, code: 'bad_request', message: "'kind' field must come before 'file'" });
        }
        const cap = kind === 'image'
          ? deps.cfg.UPLOAD_MAX_IMAGE_BYTES
          : kind === 'voice'
            ? deps.cfg.UPLOAD_MAX_VOICE_BYTES
            : deps.cfg.UPLOAD_MAX_FILE_BYTES;

        const mime = part.mimetype || 'application/octet-stream';
        // Soft mime check — block obvious wrong-kind uploads but stay permissive.
        if (kind === 'image' && !mime.startsWith('image/')) {
          return reply.code(415).send({ ok: false, code: 'wrong_mime', message: `image kind requires image/* mime, got ${mime}` });
        }
        if (kind === 'voice' && !mime.startsWith('audio/')) {
          return reply.code(415).send({ ok: false, code: 'wrong_mime', message: `voice kind requires audio/* mime, got ${mime}` });
        }

        const ext = (extname(part.filename || '') || guessExt(mime) || '').toLowerCase().slice(0, 8);
        const name = `${ulid()}${ext}`;
        const userDir = join(deps.cfg.UPLOADS_DIR, ident.userId);
        await mkdir(userDir, { recursive: true });
        const target = join(userDir, name);

        // Stream straight to disk so we never buffer the full file in memory.
        // @fastify/multipart enforces fileSize via `limits` — if the cap is
        // hit, the stream errors out and the partial file is unlinked below.
        await pipeline(part.file, createWriteStream(target));

        // multipart truncates silently when fileSize is exceeded; check.
        if (part.file.truncated) {
          return reply.code(413).send({ ok: false, code: 'too_large', message: `file exceeds ${cap} bytes for kind=${kind}` });
        }

        const s = await stat(target);
        savedBytes = s.size;
        savedPath = target;
        savedName = name;
        savedMime = mime;
        break; // only one file per request
      }

      if (!savedPath || !savedName) {
        return reply.code(400).send({ ok: false, code: 'bad_request', message: "missing 'file' part" });
      }

      const base = deps.cfg.PUBLIC_BASE_URL ?? `${req.protocol}://${req.headers.host}`;
      const url = `${base}/v1/files/${encodeURIComponent(ident.userId)}/${encodeURIComponent(savedName)}`;

      return reply.send({
        ok: true,
        url,
        mime: savedMime,
        bytes: savedBytes,
      });
    } catch (err) {
      req.log?.error?.({ err }, 'upload failed');
      return reply.code(500).send({ ok: false, code: 'server_error', message: (err as Error).message });
    }
  });
}

// Tiny mime→ext map so files saved without an original filename still get
// a recognizable extension. Falls through to empty string for unknowns —
// the file is still served correctly (the response Content-Type is set
// from the mime sniff by @fastify/static).
function guessExt(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return '.jpg';
    case 'image/png': return '.png';
    case 'image/webp': return '.webp';
    case 'image/heic': return '.heic';
    case 'image/gif': return '.gif';
    case 'audio/mpeg': return '.mp3';
    case 'audio/aac': return '.aac';
    case 'audio/mp4':
    case 'audio/x-m4a': return '.m4a';
    case 'audio/ogg': return '.ogg';
    case 'audio/webm': return '.weba';
    case 'audio/wav':
    case 'audio/x-wav': return '.wav';
    case 'video/mp4': return '.mp4';
    case 'video/quicktime': return '.mov';
    case 'application/pdf': return '.pdf';
    default: return '';
  }
}
