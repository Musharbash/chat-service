import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Logger } from './logger';
import type { AppConfig } from './config';

// Sweeper job — runs on a periodic timer. Two responsibilities:
//   1. Move undelivered stream entries older than UNDELIVERED_TTL_DAYS into the
//      Postgres `undelivered_spill` table, so they survive past the Redis cap.
//   2. Delete spilled rows that are past their hard expiry.
//
// We do NOT scan all users — instead the gateway maintains a hint set of users
// who have undelivered messages; the sweeper iterates that.

const HINT_KEY = 'sweep:users';

export function createSweeper(deps: { redis: Redis; pg: Pool; log: Logger; cfg: AppConfig }) {
  const { redis, pg, log, cfg } = deps;

  async function tick(): Promise<void> {
    try {
      const ttlMs = cfg.UNDELIVERED_TTL_DAYS * 24 * 3600 * 1000;
      const cutoffMs = Date.now() - ttlMs;
      // Stream IDs in Redis are `<ms>-<seq>` — we can XRANGE up to `<cutoff>-0` to grab everything older.
      const users = await redis.smembers(HINT_KEY);
      let spilled = 0;
      for (const userId of users) {
        const key = `stream:undelivered:${userId}`;
        const entries = await redis.xrange(key, '-', `${cutoffMs}-0`);
        if (entries.length === 0) continue;
        for (const [id, fields] of entries) {
          const fieldsMap = new Map<string, string>();
          for (let i = 0; i < fields.length; i += 2) fieldsMap.set(fields[i]!, fields[i + 1]!);
          const payload = fieldsMap.get('payload');
          const clientId = fieldsMap.get('clientId');
          if (!payload || !clientId) continue;
          try {
            const parsed = JSON.parse(payload) as { from: string; to: string };
            await pg.query(
              `INSERT INTO undelivered_spill (client_id, sender_id, recipient_id, payload, enqueued_at, expires_at)
               VALUES ($1, $2, $3, $4::jsonb, NOW(), NOW() + INTERVAL '90 days')
               ON CONFLICT (client_id) DO NOTHING`,
              [clientId, parsed.from, parsed.to, payload],
            );
            await redis.xdel(key, id);
            spilled++;
          } catch (err) {
            log.warn({ err, userId }, 'failed to spill entry — leaving in stream');
          }
        }
        // If the stream is now empty, drop the hint membership.
        const remaining = await redis.xlen(key);
        if (remaining === 0) await redis.srem(HINT_KEY, userId);
      }

      const purged = await pg.query('DELETE FROM undelivered_spill WHERE expires_at < NOW()');
      log.info({ spilled, purged: purged.rowCount }, 'sweeper tick complete');
    } catch (err) {
      log.error({ err }, 'sweeper tick failed');
    }
  }

  let timer: NodeJS.Timeout | null = null;
  return {
    start(): void {
      // Run once at startup then on interval.
      void tick();
      timer = setInterval(tick, cfg.SWEEP_INTERVAL_SECONDS * 1000);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
