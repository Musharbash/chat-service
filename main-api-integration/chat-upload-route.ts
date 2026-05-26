// Drop-in Express route for chat media uploads. Add to your main Artook API.
//
// Mount alongside chat-routes.ts:
//   import { chatRoutes } from './routes/chat-routes';
//   import { chatUploadRoutes } from './routes/chat-upload-route';
//   app.use('/chat', chatRoutes);
//   app.use('/chat', chatUploadRoutes);
//
// Requires:
//   npm install multer mime-types sharp
//   npm install --save-dev @types/multer @types/mime-types
//
// And these env vars:
//   CHAT_UPLOAD_DIR=/var/data/artook/chat-uploads     (where files live on disk)
//   CHAT_UPLOAD_PUBLIC_BASE=https://api.creativersion.tech/uploads/chat
//     (the public URL prefix Caddy/nginx serves CHAT_UPLOAD_DIR at)
//   CHAT_UPLOAD_MAX_MB=20                              (per-file cap)
//
// To serve the files publicly (option A — Caddy):
//   In your main API's Caddyfile, add:
//     handle_path /uploads/chat/* {
//       root * /var/data/artook/chat-uploads
//       file_server
//     }
//
// Option B — let Express serve them (only for MVP, not great for production):
//   app.use('/uploads/chat', express.static(process.env.CHAT_UPLOAD_DIR));
//
// Option C — production: replace the local disk write with an S3/R2 upload.

import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { mkdir, stat } from 'fs/promises';
import { join, extname } from 'path';
import { lookup as lookupMime } from 'mime-types';
import sharp from 'sharp';

// --- config ---------------------------------------------------------------

const UPLOAD_DIR = process.env.CHAT_UPLOAD_DIR ?? '/var/data/artook/chat-uploads';
const PUBLIC_BASE = (process.env.CHAT_UPLOAD_PUBLIC_BASE ?? 'https://api.example.com/uploads/chat').replace(/\/$/, '');
const MAX_MB = Number(process.env.CHAT_UPLOAD_MAX_MB ?? '20');

const ALLOWED_MIME = new Set([
  // images
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
  // voice (Android records m4a, iOS aac)
  'audio/mp4', 'audio/aac', 'audio/m4a', 'audio/x-m4a', 'audio/ogg', 'audio/mpeg', 'audio/webm',
  // generic file (extend as you need)
  'application/pdf',
  'application/zip', 'application/x-zip-compressed',
]);

// --- multer setup ---------------------------------------------------------

const storage = multer.diskStorage({
  destination: async (req, _file, cb) => {
    const userId = (req as AuthedRequest).user?.id ?? 'anon';
    const dir = join(UPLOAD_DIR, userId);
    await mkdir(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    // ULID-ish: timestamp + random hex. Avoids leaking the original filename.
    const id = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
    cb(null, `${id}${extname(file.originalname) || ''}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(new Error(`mime ${file.mimetype} not allowed`));
      return;
    }
    cb(null, true);
  },
});

// --- auth shim ------------------------------------------------------------

interface AuthedRequest extends Request {
  user?: { id: string };
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  // REPLACE with your project's actual auth middleware (or remove if it's
  // already mounted globally before this router).
  if (!req.user?.id) {
    res.status(401).json({ ok: false, code: 'unauthorized' });
    return;
  }
  next();
}

// --- routes ---------------------------------------------------------------

export const chatUploadRoutes = Router();

/**
 * POST /chat/upload
 *
 * multipart/form-data:
 *   file: the binary
 *   kind: 'image' | 'voice' | 'file'
 *
 * Response:
 *   200 { ok: true, url, width?, height?, bytes, mime, durationMs? }
 *   400 { ok: false, code: 'bad_request', message }
 *   401 { ok: false, code: 'unauthorized' }
 *   413 { ok: false, code: 'too_large' }
 */
chatUploadRoutes.post('/upload', requireAuth, upload.single('file'), async (req: AuthedRequest, res: Response) => {
  if (!req.file) {
    res.status(400).json({ ok: false, code: 'bad_request', message: 'file field required' });
    return;
  }
  const userId = req.user!.id;
  const kind = (req.body?.kind ?? 'file').toString();
  if (!['image', 'voice', 'file'].includes(kind)) {
    res.status(400).json({ ok: false, code: 'bad_request', message: 'invalid kind' });
    return;
  }

  const file = req.file;
  const stats = await stat(file.path);
  const mime = file.mimetype || lookupMime(file.filename) || 'application/octet-stream';
  const publicPath = `${userId}/${file.filename}`;
  const url = `${PUBLIC_BASE}/${publicPath}`;

  let width: number | undefined;
  let height: number | undefined;

  // For images: probe dimensions so the client can render with the right aspect ratio.
  if (kind === 'image') {
    try {
      const meta = await sharp(file.path).metadata();
      width = meta.width;
      height = meta.height;
    } catch {
      // Non-fatal — dimensions are optional in the message body schema.
    }
  }

  // For voice: ideally probe duration via ffprobe, but that's an extra dep.
  // The client's recorder already tracks duration; we just echo it back if provided.
  const durationMs = req.body?.durationMs ? Number(req.body.durationMs) : undefined;

  res.json({
    ok: true,
    url,
    width,
    height,
    bytes: stats.size,
    mime,
    ...(durationMs ? { durationMs } : {}),
  });
});

// Global multer error handler — runs only when this router throws.
chatUploadRoutes.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err.message?.includes('File too large')) {
    res.status(413).json({ ok: false, code: 'too_large', message: `max ${MAX_MB}MB` });
    return;
  }
  if (err.message?.includes('mime')) {
    res.status(400).json({ ok: false, code: 'unsupported_media_type', message: err.message });
    return;
  }
  // eslint-disable-next-line no-console
  console.error('chat upload error:', err);
  res.status(500).json({ ok: false, code: 'server_error' });
});
