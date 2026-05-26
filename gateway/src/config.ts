import { readFileSync } from 'fs';
import { z } from 'zod';

// Treat empty strings the same as missing values so `.optional()` on URL fields
// works with `.env` files (where a blank line VAR= reads as empty string, not undefined).
const emptyToUndefined = (val: unknown): unknown =>
  typeof val === 'string' && val.trim() === '' ? undefined : val;

const Env = z.object({
  NODE_ENV: z.string().default('production'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  REDIS_URL: z.string().url(),
  POSTGRES_URL: z.string().url(),
  // EITHER paste the PEM directly (with \n escapes) OR point at a file.
  // The file form is far more robust under docker-compose .env handling.
  JWT_PUBLIC_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  JWT_PUBLIC_KEY_FILE: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  JWT_ISSUER: z.string().default('artook-api'),
  JWT_AUDIENCE: z.string().default('artook-chat'),
  SOCKET_PATH: z.string().default('/socket.io'),
  CORS_ORIGIN: z.string().default('*'),
});

export interface AppConfig extends Omit<z.infer<typeof Env>, 'JWT_PUBLIC_KEY' | 'JWT_PUBLIC_KEY_FILE'> {
  JWT_PUBLIC_KEY: string;
}

export function loadConfig(): AppConfig {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  const pubKey = resolvePem(parsed.data.JWT_PUBLIC_KEY, parsed.data.JWT_PUBLIC_KEY_FILE, 'JWT_PUBLIC_KEY');
  return {
    ...parsed.data,
    JWT_PUBLIC_KEY: pubKey,
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
    // Re-expand escaped newlines for single-line .env entries.
    return literal.replace(/\\n/g, '\n');
  }
  console.error(`Missing ${name}: set either ${name}_FILE (path) or ${name} (PEM body)`);
  process.exit(1);
}
