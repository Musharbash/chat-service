import pino from 'pino';

export function createLogger(level: string) {
  const isDev = process.env.NODE_ENV !== 'production';
  return pino({
    level,
    base: { svc: 'gateway' },
    timestamp: pino.stdTimeFunctions.isoTime,
    transport: isDev
      ? { target: 'pino-pretty', options: { colorize: true, singleLine: true } }
      : undefined,
  });
}

export type Logger = ReturnType<typeof createLogger>;
