import { jwtVerify, importSPKI, type KeyLike } from 'jose';
import type { AppConfig } from './config';

/// Verifies a chat socket JWT (the same token the gateway accepts on the
/// Socket.IO handshake). Used by routes that want auth without going back
/// out to the main API — uploads, for instance.
///
/// Returns the `sub` claim (userId) on success, or null on any failure
/// (signature mismatch, expired, wrong issuer/audience). Never throws —
/// callers treat null as "unauthorized".
export interface ChatJwtVerifier {
  verify(token: string): Promise<{ userId: string; deviceId?: string } | null>;
}

export async function createChatJwtVerifier(cfg: AppConfig): Promise<ChatJwtVerifier> {
  const publicKey: KeyLike = await importSPKI(cfg.JWT_PUBLIC_KEY, 'ES256');
  return {
    async verify(token: string): Promise<{ userId: string; deviceId?: string } | null> {
      try {
        const { payload } = await jwtVerify(token, publicKey, {
          issuer: cfg.JWT_ISSUER,
          audience: cfg.JWT_AUDIENCE,
        });
        const sub = payload.sub;
        if (typeof sub !== 'string' || sub.length === 0) return null;
        const deviceId = typeof payload['deviceId'] === 'string'
          ? (payload['deviceId'] as string)
          : undefined;
        return { userId: sub, deviceId };
      } catch {
        return null;
      }
    },
  };
}
