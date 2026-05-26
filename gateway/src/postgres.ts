import { Pool } from 'pg';
import type { AppConfig } from './config';

// Postgres is only used for spillover: writing messages that exceed the Redis stream TTL
// into a durable table so the worker can still attempt delivery / push later.
// Hot path NEVER touches Postgres.

export function createPgPool(cfg: AppConfig): Pool {
  return new Pool({
    connectionString: cfg.POSTGRES_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    application_name: 'artook-gateway',
  });
}
