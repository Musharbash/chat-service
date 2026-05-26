import { readdir, stat, unlink, rmdir } from 'fs/promises';
import { join } from 'path';
import type { AppConfig } from './config';
import type { createLogger } from './logger';

type Logger = ReturnType<typeof createLogger>;

/// Walks the per-user upload directories and removes files whose mtime is
/// older than UPLOAD_FILE_TTL_DAYS. Best-effort: an unlink failure on one
/// file (locked, permission flaky) doesn't stop the sweep.
///
/// Empty per-user dirs are rmdir'd to keep the tree tidy.
export async function sweepStaleUploads(cfg: AppConfig, log: Logger): Promise<{ deleted: number; bytes: number }> {
  const cutoffMs = Date.now() - cfg.UPLOAD_FILE_TTL_DAYS * 24 * 3600 * 1000;
  let deleted = 0;
  let bytes = 0;

  let userDirs: string[];
  try {
    userDirs = await readdir(cfg.UPLOADS_DIR);
  } catch (err) {
    // UPLOADS_DIR doesn't exist yet — first boot before any upload landed.
    log.debug({ err: (err as Error).message }, 'uploads dir not present, nothing to sweep');
    return { deleted: 0, bytes: 0 };
  }

  for (const userDir of userDirs) {
    const userPath = join(cfg.UPLOADS_DIR, userDir);
    let files: string[];
    try {
      const dirStat = await stat(userPath);
      if (!dirStat.isDirectory()) continue;
      files = await readdir(userPath);
    } catch {
      continue;
    }

    for (const file of files) {
      const full = join(userPath, file);
      try {
        const s = await stat(full);
        if (!s.isFile()) continue;
        if (s.mtimeMs < cutoffMs) {
          await unlink(full);
          deleted++;
          bytes += s.size;
        }
      } catch (err) {
        log.warn({ file: full, err: (err as Error).message }, 'failed to inspect/delete upload');
      }
    }

    // If the user folder is now empty, drop it. rmdir refuses non-empty dirs.
    try {
      await rmdir(userPath);
    } catch {
      // not empty or already gone — both fine
    }
  }

  return { deleted, bytes };
}

/// Schedules the sweep on a setInterval. Runs once immediately on startup
/// so a crash-loop / reboot doesn't postpone cleanup by a full interval.
/// Returns the timer handle so callers can clear it during shutdown.
export function startUploadsCleanup(cfg: AppConfig, log: Logger): NodeJS.Timeout {
  const tick = async (): Promise<void> => {
    try {
      const { deleted, bytes } = await sweepStaleUploads(cfg, log);
      if (deleted > 0) {
        log.info({ deleted, bytes, ttlDays: cfg.UPLOAD_FILE_TTL_DAYS }, 'uploads sweep purged stale files');
      } else {
        log.debug({ ttlDays: cfg.UPLOAD_FILE_TTL_DAYS }, 'uploads sweep — nothing to do');
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, 'uploads sweep failed');
    }
  };
  // Fire-and-forget initial run, then schedule subsequent ticks.
  void tick();
  return setInterval(() => void tick(), cfg.UPLOAD_CLEANUP_INTERVAL_SECONDS * 1000);
}
