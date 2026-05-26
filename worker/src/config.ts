import { z } from 'zod';

const emptyToUndefined = (val: unknown): unknown =>
  typeof val === 'string' && val.trim() === '' ? undefined : val;

const Env = z.object({
  NODE_ENV: z.string().default('production'),
  PORT: z.coerce.number().int().positive().default(4200),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  REDIS_URL: z.string().url(),
  POSTGRES_URL: z.string().url(),
  FCM_SERVICE_ACCOUNT_JSON: z.preprocess(emptyToUndefined, z.string().optional()),
  FCM_PROJECT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  UNDELIVERED_TTL_DAYS: z.coerce.number().int().positive().default(14),
  SWEEP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
});

export type AppConfig = z.infer<typeof Env>;

export function loadConfig(): AppConfig {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}
