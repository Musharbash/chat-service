import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { createPushClient } from './fcm';
import { createNotifier } from './notify';
import { createSweeper } from './sweeper';

async function main() {
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL);
  log.info({ port: cfg.PORT }, 'worker starting');

  const redisPub = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
  const redisSub = redisPub.duplicate();
  const pg = new Pool({ connectionString: cfg.POSTGRES_URL, max: 5, application_name: 'artook-worker' });
  const push = createPushClient(cfg, log);

  const app = Fastify({ logger: false });
  app.get('/healthz', async (_req, reply) => reply.send({ ok: true, svc: 'worker', pushEnabled: push.enabled }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await redisPub.ping();
      await pg.query('SELECT 1');
      return reply.send({ ok: true });
    } catch (err) {
      return reply.code(503).send({ ok: false, err: (err as Error).message });
    }
  });
  await app.listen({ port: cfg.PORT, host: '0.0.0.0' });

  const notifier = createNotifier({ redisSub, pg, push, log });
  await notifier.start();

  const sweeper = createSweeper({ redis: redisPub, pg, log, cfg });
  sweeper.start();

  const shutdown = async (signal: string) => {
    log.warn({ signal }, 'shutdown signal received');
    sweeper.stop();
    try {
      await app.close();
      await redisSub.quit();
      await redisPub.quit();
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
