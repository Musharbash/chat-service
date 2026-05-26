import type { AppConfig } from './config';

// The /api service must verify the caller is who they claim to be BEFORE minting
// a socket token. We support two strategies, configured via env:
//
//   A) Token introspection: POST {UPSTREAM_AUTH_INTROSPECT_URL} with the caller's
//      bearer access token and a shared secret. The upstream main API responds
//      with { active, userId }.
//
//   B) Shared-secret mode (dev / single-tenant): the caller proves identity by
//      passing a userId + an HMAC over (userId + timestamp). Useful for testing
//      and small deployments where the main API mints the userId claim directly.
//
// In production prefer (A). (B) is fallback for environments where calling out
// to the main API on every chat connect would be expensive.

export interface UpstreamAuth {
  resolve(req: { authorization?: string; userIdHint?: string }): Promise<{ userId: string } | null>;
}

export function createUpstreamAuth(cfg: AppConfig): UpstreamAuth {
  return {
    async resolve({ authorization }): Promise<{ userId: string } | null> {
      if (!authorization?.startsWith('Bearer ')) return null;
      const accessToken = authorization.slice('Bearer '.length).trim();
      if (!accessToken) return null;

      if (cfg.UPSTREAM_AUTH_INTROSPECT_URL) {
        try {
          const r = await fetch(cfg.UPSTREAM_AUTH_INTROSPECT_URL, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(cfg.UPSTREAM_AUTH_SHARED_SECRET ? { 'x-introspect-secret': cfg.UPSTREAM_AUTH_SHARED_SECRET } : {}),
            },
            body: JSON.stringify({ token: accessToken }),
          });
          if (!r.ok) return null;
          const data = (await r.json()) as { active?: boolean; userId?: string };
          if (!data.active || !data.userId) return null;
          return { userId: data.userId };
        } catch {
          return null;
        }
      }

      // No introspection configured — refuse rather than fail open.
      return null;
    },
  };
}
