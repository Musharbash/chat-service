import Fastify from 'fastify';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { createTokenMinter } from './token';
import { createUpstreamAuth } from './upstream-auth';
import { registerRoutes } from './routes';

async function main() {
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL);
  log.info({ port: cfg.PORT }, 'api starting');

  const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 3 });
  const pg = new Pool({ connectionString: cfg.POSTGRES_URL, max: 10, application_name: 'artook-api' });

  const minter = createTokenMinter(cfg);
  const upstream = createUpstreamAuth(cfg);

  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

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

  await registerRoutes(app, { pg, minter, upstream, cfg });

  await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
  log.info({ port: cfg.PORT }, 'HTTP up');

  const shutdown = async (signal: string) => {
    log.warn({ signal }, 'shutdown signal received');
    try {
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
