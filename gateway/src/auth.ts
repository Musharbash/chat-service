import { createPublicKey, KeyObject } from 'crypto';
import { jwtVerify } from 'jose';
import type { SocketTokenClaims } from '@artook/chat-shared';
import type { AppConfig } from './config';

// Verify socket-handshake JWTs minted by the /api service. Tokens are short-lived (~1h).
// The gateway only needs the *public* key — it cannot mint tokens, only validate them.

export interface AuthVerifier {
  verify(token: string): Promise<SocketTokenClaims>;
}

export function createAuthVerifier(cfg: AppConfig): AuthVerifier {
  let key: KeyObject;
  try {
    key = createPublicKey(cfg.JWT_PUBLIC_KEY);
  } catch (err) {
    throw new Error(`Failed to load JWT_PUBLIC_KEY (must be PEM-encoded): ${(err as Error).message}`);
  }
  return {
    async verify(token: string): Promise<SocketTokenClaims> {
      const { payload } = await jwtVerify(token, key, {
        issuer: cfg.JWT_ISSUER,
        audience: cfg.JWT_AUDIENCE,
        algorithms: ['ES256', 'RS256'],
      });
      // jose returns a JWTPayload, narrow it.
      if (typeof payload.sub !== 'string' || typeof (payload as any).deviceId !== 'string') {
        throw new Error('token missing sub/deviceId');
      }
      return payload as unknown as SocketTokenClaims;
    },
  };
}
