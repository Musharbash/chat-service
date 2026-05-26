import { readFileSync } from 'fs';
import { z } from 'zod';

// Treat empty strings the same as missing values so `.optional()` on URL fields
// works with `.env` files (a blank `VAR=` line reads as empty string, not undefined).
const emptyToUndefined = (val: unknown): unknown =>
  typeof val === 'string' && val.trim() === '' ? undefined : val;

const Env = z.object({
  NODE_ENV: z.string().default('production'),
  PORT: z.coerce.number().int().positive().default(4100),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  REDIS_URL: z.string().url(),
  POSTGRES_URL: z.string().url(),
  JWT_PRIVATE_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  JWT_PRIVATE_KEY_FILE: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  JWT_PUBLIC_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  JWT_PUBLIC_KEY_FILE: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  JWT_ISSUER: z.string().default('artook-api'),
  JWT_AUDIENCE: z.string().default('artook-chat'),
  SOCKET_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  UPSTREAM_AUTH_INTROSPECT_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  UPSTREAM_AUTH_SHARED_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  // Service-to-service secret used by the main API when calling chat-api on
  // behalf of a user (e.g. proxying device registration). The main API sends
  // `X-Service-Secret: <SERVICE_SECRET>` and an explicit userId in the body.
  // Treated as more privileged than a user bearer — keep it long + random.
  SERVICE_SECRET: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
  // Where uploaded chat media is written + read from. Must be on a Docker
  // volume so files survive container restarts. Default matches the
  // docker-compose bind mount.
  UPLOADS_DIR: z.string().default('/data/chat-uploads'),
  // Origin returned in upload responses (e.g. http://156.67.28.84:4100).
  // Used to build the absolute URL clients fetch the file from. If unset,
  // we fall back to building the URL from the request — fine in single-
  // node setups but breaks when sitting behind a proxy.
  PUBLIC_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  // Per-kind upload caps (bytes). Tune if voice notes start to exceed 10MB.
  UPLOAD_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(15 * 1024 * 1024),
  UPLOAD_MAX_VOICE_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  UPLOAD_MAX_FILE_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
});

type RawEnv = z.infer<typeof Env>;
export interface AppConfig extends Omit<RawEnv, 'JWT_PRIVATE_KEY' | 'JWT_PRIVATE_KEY_FILE' | 'JWT_PUBLIC_KEY' | 'JWT_PUBLIC_KEY_FILE'> {
  JWT_PRIVATE_KEY: string;
  JWT_PUBLIC_KEY: string;
}

export function loadConfig(): AppConfig {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return {
    ...parsed.data,
    JWT_PRIVATE_KEY: resolvePem(parsed.data.JWT_PRIVATE_KEY, parsed.data.JWT_PRIVATE_KEY_FILE, 'JWT_PRIVATE_KEY'),
    JWT_PUBLIC_KEY: resolvePem(parsed.data.JWT_PUBLIC_KEY, parsed.data.JWT_PUBLIC_KEY_FILE, 'JWT_PUBLIC_KEY'),
  };
}

function resolvePem(literal: string | undefined, filePath: string | undefined, name: string): string {
  if (filePath) {
    try {
      return readFileSync(filePath, 'utf8');
    } catch (err) {
      console.error(`Failed to read ${name}_FILE (${filePath}): ${(err as Error).message}`);
      process.exit(1);
    }
  }
  if (literal) {
    return literal.replace(/\\n/g, '\n');
  }
  console.error(`Missing ${name}: set either ${name}_FILE (path) or ${name} (PEM body)`);
  process.exit(1);
}
