// JWT claim shape minted by the api service and verified by the gateway.
export interface SocketTokenClaims {
  sub: string;        // user id
  deviceId: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

// Redis key helpers — single source of truth, no string-mashing in handlers.
export const RedisKeys = {
  socketsByUser: (userId: string) => `user:sockets:${userId}`,
  userBySocket:  (socketId: string) => `socket:user:${socketId}`,
  presence:      (userId: string) => `presence:${userId}`,
  undeliveredStream: (userId: string) => `stream:undelivered:${userId}`,
  serverSeq:     (userId: string) => `seq:${userId}`,
  idempotency:   (clientId: string) => `idemp:${clientId}`,
  recalled:      (clientId: string) => `recall:${clientId}`,
} as const;

// Redis Stream payload field for undelivered messages.
// Stored as a single JSON-encoded field for simplicity; XADD/XRANGE preserve order.
export interface UndeliveredStreamFields {
  payload: string; // JSON-encoded ServerMessage
}
