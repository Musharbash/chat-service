import { createPrivateKey, KeyObject } from 'crypto';
import { SignJWT } from 'jose';
import type { AppConfig } from './config';

// Mints short-lived ES256 JWTs that the gateway will accept on the socket handshake.
// Signing happens here (api owns the private key); verification happens at the gateway (public key only).

export interface TokenMinter {
  mint(input: { userId: string; deviceId: string }): Promise<{ token: string; expiresAt: number }>;
}

function detectAlgFromPem(pem: string): 'ES256' | 'RS256' {
  // Trivial heuristic — EC keys carry "BEGIN EC PRIVATE KEY" or oid prime256v1.
  // Default to ES256 (smaller signatures, native to Node + Flutter without bigint pain).
  if (pem.includes('BEGIN EC PRIVATE KEY') || pem.includes('PRIME256V1')) return 'ES256';
  if (pem.includes('BEGIN RSA PRIVATE KEY') || pem.includes('BEGIN PRIVATE KEY')) {
    // PKCS#8 could be either — try ES256 first since that's the docs default.
    return 'ES256';
  }
  return 'ES256';
}

export function createTokenMinter(cfg: AppConfig): TokenMinter {
  let key: KeyObject;
  try {
    key = createPrivateKey(cfg.JWT_PRIVATE_KEY);
  } catch (err) {
    throw new Error(`Failed to load JWT_PRIVATE_KEY (must be PEM-encoded): ${(err as Error).message}`);
  }
  const alg = detectAlgFromPem(cfg.JWT_PRIVATE_KEY);

  return {
    async mint(input: { userId: string; deviceId: string }): Promise<{ token: string; expiresAt: number }> {
      const nowSec = Math.floor(Date.now() / 1000);
      const exp = nowSec + cfg.SOCKET_TOKEN_TTL_SECONDS;
      const token = await new SignJWT({ deviceId: input.deviceId })
        .setProtectedHeader({ alg })
        .setSubject(input.userId)
        .setIssuer(cfg.JWT_ISSUER)
        .setAudience(cfg.JWT_AUDIENCE)
        .setIssuedAt(nowSec)
        .setExpirationTime(exp)
        .sign(key);
      return { token, expiresAt: exp };
    },
  };
}
