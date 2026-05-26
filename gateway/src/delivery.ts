import type { Server } from 'socket.io';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { RedisKeys, ServerEvent, type ServerMessage } from '@artook/chat-shared';
import type { Logger } from './logger';
import type { PresenceTracker } from './presence';

// Encapsulates the "fan a message out to its recipient" logic. Two paths:
//
//   1. Recipient is online (sockets set non-empty) → emit `message:new` directly. If they ack, stream entry is XDEL'd.
//   2. Recipient is offline → XADD onto stream:undelivered:<userId>, capped at MAXLEN ~10k.
//      Then publish to the `notify:offline` channel so the worker fires FCM.
//      On reconnect, the gateway replays from the stream via the sync:since handler.
//
// In both cases we ALWAYS XADD first, then attempt emit. This is the standard at-least-once
// guarantee — the recipient's `message:ack:delivered` ack is what triggers XDEL.

const MAX_STREAM_LEN = 10_000;
const NOTIFY_CHANNEL = 'notify:offline';
const SWEEP_HINT_KEY = 'sweep:users';

export interface Deliverer {
  deliver(msg: ServerMessage): Promise<void>;
  /** Replay all undelivered messages for a user since the given seq. Returns the count delivered. */
  replaySince(userId: string, lastServerSeq: number, socketId: string): Promise<number>;
  /** Drop a single message from the undelivered queue once acknowledged by recipient. */
  ackDelivered(userId: string, clientId: string): Promise<void>;
}

export function createDeliverer(io: Server, redis: Redis, _pg: Pool, log: Logger, presence: PresenceTracker): Deliverer {
  async function enqueue(msg: ServerMessage): Promise<string> {
    const key = RedisKeys.undeliveredStream(msg.to);
    const id = await redis.xadd(
      key,
      'MAXLEN', '~', String(MAX_STREAM_LEN),
      '*',
      'payload', JSON.stringify(msg),
      'clientId', msg.clientId,
      'serverSeq', String(msg.serverSeq),
    );
    // Record that this user has pending entries so the sweeper iterates only relevant streams.
    await redis.sadd(SWEEP_HINT_KEY, msg.to);
    return id ?? '0-0';
  }

  function previewFromBody(msg: ServerMessage): string {
    const b = msg.body;
    if (b.runtimeType === 'text') return b.text.length > 80 ? `${b.text.slice(0, 80)}…` : b.text;
    if (b.runtimeType === 'image') return '📷 Photo';
    if (b.runtimeType === 'voice') return '🎤 Voice message';
    return 'New message';
  }

  return {
    async deliver(msg: ServerMessage): Promise<void> {
      const streamId = await enqueue(msg);
      const online = await presence.isOnline(msg.to);
      const room = `u:${msg.to}`;
      // INFO level so the routing is visible without raising the global log level.
      log.info(
        { from: msg.from, to: msg.to, clientId: msg.clientId, streamId, online, room },
        'delivering message',
      );
      io.to(room).emit(ServerEvent.MessageNew, msg);
      if (!online) {
        await redis.publish(
          NOTIFY_CHANNEL,
          JSON.stringify({
            recipientId: msg.to,
            senderId: msg.from,
            preview: previewFromBody(msg),
            clientId: msg.clientId,
          }),
        );
      }
    },

    async replaySince(userId: string, lastServerSeq: number, socketId: string): Promise<number> {
      const key = RedisKeys.undeliveredStream(userId);
      // XRANGE returns ascending; lastServerSeq is server-side ordering, so we filter on it.
      const entries = await redis.xrange(key, '-', '+');
      let delivered = 0;
      for (const [, fields] of entries) {
        const fieldsMap = new Map<string, string>();
        for (let i = 0; i < fields.length; i += 2) fieldsMap.set(fields[i]!, fields[i + 1]!);
        const seq = Number(fieldsMap.get('serverSeq') ?? '0');
        if (seq <= lastServerSeq) continue;
        const raw = fieldsMap.get('payload');
        if (!raw) continue;
        try {
          const msg = JSON.parse(raw) as ServerMessage;
          io.to(socketId).emit(ServerEvent.MessageNew, msg);
          delivered++;
        } catch (err) {
          log.warn({ err, userId }, 'malformed stream entry, skipping');
        }
      }
      return delivered;
    },

    async ackDelivered(userId: string, clientId: string): Promise<void> {
      const key = RedisKeys.undeliveredStream(userId);
      // Best-effort: find and delete the entry whose clientId field matches.
      // XRANGE is O(n) on the stream but n is bounded by MAX_STREAM_LEN per user.
      const entries = await redis.xrange(key, '-', '+');
      for (const [id, fields] of entries) {
        const fieldsMap = new Map<string, string>();
        for (let i = 0; i < fields.length; i += 2) fieldsMap.set(fields[i]!, fields[i + 1]!);
        if (fieldsMap.get('clientId') === clientId) {
          await redis.xdel(key, id);
          return;
        }
      }
    },
  };
}
