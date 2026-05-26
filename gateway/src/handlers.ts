import type { Server, Socket } from 'socket.io';
import type { Redis } from 'ioredis';
import {
  ClientEvent,
  ServerEvent,
  SendMessageInput,
  AckInput,
  RecallInput,
  PresenceSubscribeInput,
  TypingInput,
  SyncSinceInput,
  RedisKeys,
  type ServerMessage,
  type SocketTokenClaims,
} from '@artook/chat-shared';
import type { Logger } from './logger';
import type { Deliverer } from './delivery';
import type { PresenceTracker } from './presence';

// Idempotency window: a client that retries a send with the same clientId within 24h
// gets the SAME serverSeq back. Without this, a retry would create a duplicate.
const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;

interface HandlerDeps {
  io: Server;
  redis: Redis;
  log: Logger;
  deliverer: Deliverer;
  presence: PresenceTracker;
}

interface AuthedSocket extends Socket {
  data: {
    user: SocketTokenClaims;
  };
}

function isAuthed(s: Socket): s is AuthedSocket {
  return Boolean(s.data?.user?.sub);
}

export function registerHandlers(socket: Socket, deps: HandlerDeps): void {
  if (!isAuthed(socket)) {
    // Defense in depth — auth middleware should have rejected this already.
    socket.disconnect(true);
    return;
  }
  const { io, redis, log, deliverer, presence } = deps;
  const userId = socket.data.user.sub;

  socket.on(ClientEvent.MessageSend, async (raw: unknown, ack?: (resp: unknown) => void) => {
    log.info({ from: userId, raw }, 'message:send received');
    const parsed = SendMessageInput.safeParse(raw);
    if (!parsed.success) {
      log.warn({ from: userId, errors: parsed.error.flatten() }, 'message:send rejected (validation)');
      ack?.({ ok: false, code: 'bad_request', message: 'invalid send payload' });
      return;
    }
    const input = parsed.data;

    // Idempotency: if we've seen this clientId before, return the cached envelope.
    // We store the JSON-encoded ServerMessage so the second response is byte-identical.
    const idemKey = RedisKeys.idempotency(input.clientId);
    const cached = await redis.get(idemKey);
    if (cached) {
      try {
        const prior = JSON.parse(cached) as ServerMessage;
        ack?.({ ok: true, serverSeq: prior.serverSeq, serverAtMs: prior.serverAtMs });
        return;
      } catch {
        // fall through and treat as fresh
      }
    }

    // Allocate a per-recipient monotonic seq. INCR returns the new value atomically.
    const serverSeq = await redis.incr(RedisKeys.serverSeq(input.to));
    const serverAtMs = Date.now();
    const msg: ServerMessage = {
      clientId: input.clientId,
      from: userId,
      to: input.to,
      body: input.body,
      sentAtMs: input.sentAtMs,
      serverAtMs,
      serverSeq,
    };

    await redis.set(idemKey, JSON.stringify(msg), 'EX', IDEMPOTENCY_TTL_SECONDS);
    await deliverer.deliver(msg);
    ack?.({ ok: true, serverSeq, serverAtMs });
  });

  socket.on(ClientEvent.MessageAck, async (raw: unknown, ack?: (resp: unknown) => void) => {
    const parsed = AckInput.safeParse(raw);
    if (!parsed.success) {
      ack?.({ ok: false, code: 'bad_request', message: 'invalid ack payload' });
      return;
    }
    const { clientId, kind, conversationPeer } = parsed.data;

    if (kind === 'delivered') {
      // Recipient ack — the message landed in their app. Drop from undelivered queue.
      await deliverer.ackDelivered(userId, clientId);
    }

    // In all cases, notify the original sender so their UI flips the tick.
    // We don't store who the sender was on the gateway — it's encoded in the
    // ServerMessage at deliver time. For read acks we route by conversationPeer
    // (the other party) which the client knows.
    const senderRoom = `u:${conversationPeer ?? ''}`;
    if (conversationPeer) {
      const event = kind === 'read' ? ServerEvent.MessageAckRead : ServerEvent.MessageAckDelivered;
      io.to(senderRoom).emit(event, { clientId, by: userId, atMs: Date.now() });
    }

    ack?.({ ok: true });
  });

  socket.on(ClientEvent.MessageRecall, async (raw: unknown, ack?: (resp: unknown) => void) => {
    const parsed = RecallInput.safeParse(raw);
    if (!parsed.success) {
      ack?.({ ok: false, code: 'bad_request', message: 'invalid recall payload' });
      return;
    }
    const { clientId } = parsed.data;

    // Look up the original envelope from the idempotency cache to find the recipient.
    const cached = await redis.get(RedisKeys.idempotency(clientId));
    if (!cached) {
      ack?.({ ok: false, code: 'not_found', message: 'message past retention window' });
      return;
    }
    let msg: ServerMessage;
    try {
      msg = JSON.parse(cached) as ServerMessage;
    } catch {
      ack?.({ ok: false, code: 'corrupt', message: 'unable to parse cached message' });
      return;
    }
    if (msg.from !== userId) {
      ack?.({ ok: false, code: 'forbidden', message: 'not your message' });
      return;
    }

    // Drop from recipient's undelivered queue (no-op if already delivered),
    // mark recalled so any in-flight replays skip it, and broadcast the recall.
    await deliverer.ackDelivered(msg.to, clientId);
    await redis.set(RedisKeys.recalled(clientId), '1', 'EX', 30 * 24 * 3600);
    io.to(`u:${msg.to}`).emit(ServerEvent.MessageRecalled, { clientId, by: userId, atMs: Date.now() });
    ack?.({ ok: true });
  });

  socket.on(ClientEvent.PresenceSubscribe, async (raw: unknown) => {
    const parsed = PresenceSubscribeInput.safeParse(raw);
    if (!parsed.success) return;
    for (const id of parsed.data.userIds) socket.join(`p:${id}`);
    const states = await presence.bulkOnline(parsed.data.userIds);
    for (const [uid, online] of Object.entries(states)) {
      socket.emit(ServerEvent.PresenceUpdate, { userId: uid, online, atMs: Date.now() });
    }
  });

  socket.on(ClientEvent.PresenceUnsubscribe, (raw: unknown) => {
    const parsed = PresenceSubscribeInput.safeParse(raw);
    if (!parsed.success) return;
    for (const id of parsed.data.userIds) socket.leave(`p:${id}`);
  });

  socket.on(ClientEvent.Typing, (raw: unknown) => {
    const parsed = TypingInput.safeParse(raw);
    if (!parsed.success) return;
    // Typing is ephemeral — never queued, no ack, no Postgres. Pure broadcast to recipient.
    io.to(`u:${parsed.data.to}`).emit(ServerEvent.TypingUpdate, {
      from: userId,
      isTyping: parsed.data.isTyping,
      atMs: Date.now(),
    });
  });

  socket.on(ClientEvent.SyncSince, async (raw: unknown, ack?: (resp: unknown) => void) => {
    const parsed = SyncSinceInput.safeParse(raw);
    if (!parsed.success) {
      ack?.({ ok: false, code: 'bad_request', message: 'invalid sync payload' });
      return;
    }
    const replayed = await deliverer.replaySince(userId, parsed.data.lastServerSeq, socket.id);
    ack?.({ ok: true, replayed });
  });

  socket.on('disconnect', async (reason) => {
    log.info({ userId, socketId: socket.id, reason }, 'socket disconnected');
    const { nowOffline } = await presence.removeSocket(socket.id);
    if (nowOffline) {
      io.to(`p:${userId}`).emit(ServerEvent.PresenceUpdate, {
        userId,
        online: false,
        atMs: Date.now(),
      });
    }
  });

  // Heartbeat: client emits 'hb' every ~30s; we refresh presence TTL.
  socket.on('hb', async () => {
    await presence.touch(userId);
  });
}
