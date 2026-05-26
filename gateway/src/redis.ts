import { Redis } from 'ioredis';
import type { AppConfig } from './config';

// Two clients are needed:
//   - pub: regular commands (XADD, SADD, etc.)
//   - sub: subscriber for the Socket.IO adapter (pub/sub channels)
// They MUST be separate connections because Redis disallows other commands on a connection in subscribe mode.

export interface RedisClients {
  pub: Redis;
  sub: Redis;
}

export function createRedisClients(cfg: AppConfig): RedisClients {
  const opts = {
    maxRetriesPerRequest: null, // never throw on transient; the adapter wants long-running subs
    enableReadyCheck: true,
    lazyConnect: false,
  } as const;
  const pub = new Redis(cfg.REDIS_URL, opts);
  const sub = pub.duplicate();
  return { pub, sub };
}
