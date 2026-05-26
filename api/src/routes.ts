import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { TokenMinter } from './token';
import type { UpstreamAuth } from './upstream-auth';
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

// Resolves the calling identity. Two paths:
//   1. X-Service-Secret header matches SERVICE_SECRET → trust the body's userId.
//   2. Authorization: Bearer → introspect via UpstreamAuth.
// Returns null on auth failure.
async function resolveCaller(
  req: FastifyRequest,
  cfg: AppConfig,
  upstream: UpstreamAuth,
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
  return upstream.resolve({ authorization: req.headers.authorization });
}

export async function registerRoutes(
  app: FastifyInstance,
  deps: { pg: Pool; minter: TokenMinter; upstream: UpstreamAuth; cfg: AppConfig },
): Promise<void> {
  // Mint a socket-token. Same as before — requires user bearer (introspected
  // upstream) OR service-secret + explicit userId.
  app.post('/v1/socket-token', async (req, reply) => {
    const parsed = SocketTokenRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: 'bad_request' });

    const ident = await resolveCaller(req, deps.cfg, deps.upstream, req.body as { userId?: string });
    if (!ident) return reply.code(401).send({ ok: false, code: 'unauthorized' });

    const minted = await deps.minter.mint({ userId: ident.userId, deviceId: parsed.data.deviceId });
    return reply.send({ ok: true, token: minted.token, expiresAt: minted.expiresAt, userId: ident.userId });
  });

  // Register / refresh a device's FCM push token.
  app.post('/v1/devices', async (req, reply) => {
    const parsed = DeviceRegisterRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: 'bad_request' });

    const ident = await resolveCaller(req, deps.cfg, deps.upstream, parsed.data);
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
    const ident = await resolveCaller(req, deps.cfg, deps.upstream, req.body as { userId?: string });
    if (!ident) return reply.code(401).send({ ok: false, code: 'unauthorized' });
    const params = req.params as { deviceId?: string };
    if (!params.deviceId) return reply.code(400).send({ ok: false, code: 'bad_request' });
    await deps.pg.query('DELETE FROM devices WHERE device_id = $1 AND user_id = $2', [
      params.deviceId,
      ident.userId,
    ]);
    return reply.send({ ok: true });
  });
}
