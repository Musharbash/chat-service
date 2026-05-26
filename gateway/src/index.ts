import Fastify from 'fastify';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { createRedisClients } from './redis';
import { createPgPool } from './postgres';
import { createAuthVerifier } from './auth';
import { PresenceTracker } from './presence';
import { createDeliverer } from './delivery';
import { registerHandlers } from './handlers';
import { ServerEvent } from '@artook/chat-shared';

async function main() {
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL);
  log.info({ port: cfg.PORT, env: cfg.NODE_ENV }, 'gateway starting');

  const redis = createRedisClients(cfg);
  const pg = createPgPool(cfg);

  // Fastify handles /healthz and serves as the HTTP layer Socket.IO attaches to.
  const app = Fastify({ logger: false });
  app.get('/healthz', async (_req, reply) => {
    // Liveness: process is up. Readiness check is separate.
    return reply.send({ ok: true, svc: 'gateway' });
  });
  app.get('/readyz', async (_req, reply) => {
    try {
      await redis.pub.ping();
      await pg.query('SELECT 1');
      return reply.send({ ok: true });
    } catch (err) {
      return reply.code(503).send({ ok: false, err: (err as Error).message });
    }
  });

  await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
  log.info({ port: cfg.PORT }, 'HTTP up');

  // Attach Socket.IO to the Fastify HTTP server.
  const io = new Server(app.server, {
    path: cfg.SOCKET_PATH,
    cors: { origin: cfg.CORS_ORIGIN, credentials: false },
    serveClient: false,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    transports: ['websocket', 'polling'],
  });

  // Redis adapter — cross-replica fan-out. Critical for horizontal scaling.
  io.adapter(createAdapter(redis.pub, redis.sub));

  // Auth middleware. Token MUST be passed in the handshake auth payload as { token }.
  const verifier = createAuthVerifier(cfg);
  io.use(async (socket, next) => {
    const token = (socket.handshake.auth as { token?: string })?.token;
    if (!token) return next(new Error('missing token'));
    try {
      const claims = await verifier.verify(token);
      (socket.data as any).user = claims;
      next();
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'auth rejected');
      next(new Error('unauthorized'));
    }
  });

  const presence = new PresenceTracker(redis.pub);
  const deliverer = createDeliverer(io, redis.pub, pg, log, presence);

  io.on('connection', async (socket) => {
    const claims = socket.data.user as { sub: string };
    const userId = claims.sub;
    log.info({ userId, socketId: socket.id }, 'socket connected');

    socket.join(`u:${userId}`);
    const cameOnline = await presence.addSocket(userId, socket.id);
    if (cameOnline) {
      // Broadcast to anyone subscribed to this user's presence room.
      io.to(`p:${userId}`).emit(ServerEvent.PresenceUpdate, {
        userId,
        online: true,
        atMs: Date.now(),
      });
    }

    registerHandlers(socket, { io, redis: redis.pub, log, deliverer, presence });
  });

  // Graceful shutdown — drain sockets before killing the process so in-flight acks land.
  const shutdown = async (signal: string) => {
    log.warn({ signal }, 'shutdown signal received');
    try {
      io.close();
      await app.close();
      await redis.pub.quit();
      await redis.sub.quit();
      await pg.end();
    } catch (err) {
      log.error({ err }, 'error during shutdown');
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal startup error', err);
  process.exit(1);
});
