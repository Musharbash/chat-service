import { mkdir } from 'fs/promises';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { createTokenMinter } from './token';
import { createUpstreamAuth } from './upstream-auth';
import { createChatJwtVerifier } from './verify-chat-jwt';
import { registerRoutes } from './routes';
import { startUploadsCleanup } from './uploads-cleanup';

async function main() {
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL);
  log.info({ port: cfg.PORT }, 'api starting');

  const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 3 });
  const pg = new Pool({ connectionString: cfg.POSTGRES_URL, max: 10, application_name: 'artook-api' });

  const minter = createTokenMinter(cfg);
  const upstream = createUpstreamAuth(cfg);
  const chatJwt = await createChatJwtVerifier(cfg);

  // Make sure the uploads dir exists. Idempotent; runs on every boot.
  await mkdir(cfg.UPLOADS_DIR, { recursive: true });

  // bodyLimit caps non-multipart bodies; multipart caps come from its own
  // `limits` config below. Largest multipart cap drives the global one we
  // pass to multipart, so a single config knob covers both.
  const maxBytes = Math.max(
    cfg.UPLOAD_MAX_IMAGE_BYTES,
    cfg.UPLOAD_MAX_VOICE_BYTES,
    cfg.UPLOAD_MAX_FILE_BYTES,
  );
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

  await app.register(multipart, {
    limits: {
      fileSize: maxBytes,
      files: 1, // one file per request — clients upload sequentially
      fieldSize: 1024 * 1024,
    },
  });

  // Serve uploaded files back. `decorateReply: false` because we register
  // it only for /v1/files/* and the rest of the API doesn't need static.
  await app.register(fastifyStatic, {
    root: cfg.UPLOADS_DIR,
    prefix: '/v1/files/',
    decorateReply: false,
    serve: true,
    index: false,
    // Long cache — file names are ulid-based so they're effectively immutable.
    maxAge: 60 * 60 * 24 * 30 * 1000,
    immutable: true,
  });

  app.get('/healthz', async (_req, reply) => reply.send({ ok: true, svc: 'api' }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await redis.ping();
      await pg.query('SELECT 1');
      return reply.send({ ok: true });
    } catch (err) {
      return reply.code(503).send({ ok: false, err: (err as Error).message });
    }
  });

  await registerRoutes(app, { pg, minter, upstream, cfg, chatJwt });

  await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
  log.info({ port: cfg.PORT }, 'HTTP up');

  // Background loop that nukes uploaded files older than UPLOAD_FILE_TTL_DAYS.
  // Chat is relay-only; files outliving message delivery are dead weight.
  const cleanupTimer = startUploadsCleanup(cfg, log);

  const shutdown = async (signal: string) => {
    log.warn({ signal }, 'shutdown signal received');
    try {
      clearInterval(cleanupTimer);
      await app.close();
      await redis.quit();
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
