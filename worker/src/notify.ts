import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { PushClient } from './fcm';
import type { Logger } from './logger';

// The gateway publishes to channel `notify:offline` whenever a message is enqueued
// for a user that has no live sockets. Payload shape:
//
//   { recipientId: string, senderId: string, preview: string, clientId: string }
//
// This subscriber translates that into FCM pushes to all the recipient's registered devices.

export const NOTIFY_CHANNEL = 'notify:offline';

interface NotifyPayload {
  recipientId: string;
  senderId: string;
  senderName?: string;
  preview: string;
  clientId: string;
}

export function createNotifier(deps: { redisSub: Redis; pg: Pool; push: PushClient; log: Logger }) {
  const { redisSub, pg, push, log } = deps;

  async function handle(raw: string): Promise<void> {
    let p: NotifyPayload;
    try {
      p = JSON.parse(raw) as NotifyPayload;
    } catch {
      log.warn({ raw }, 'invalid notify payload');
      return;
    }

    const { rows } = await pg.query<{ push_token: string | null }>(
      'SELECT push_token FROM devices WHERE user_id = $1 AND push_token IS NOT NULL',
      [p.recipientId],
    );
    const tokens = rows.map((r) => r.push_token!).filter(Boolean);
    if (tokens.length === 0) {
      log.debug({ recipientId: p.recipientId }, 'no push tokens — skipping');
      return;
    }

    const result = await push.push({
      tokens,
      title: p.senderName ?? 'New message',
      body: p.preview,
      data: {
        type: 'chat',
        senderId: p.senderId,
        clientId: p.clientId,
      },
    });
    log.info({ recipientId: p.recipientId, sent: result.sent, failed: result.failed }, 'push attempted');
  }

  return {
    async start(): Promise<void> {
      await redisSub.subscribe(NOTIFY_CHANNEL);
      redisSub.on('message', (channel, message) => {
        if (channel !== NOTIFY_CHANNEL) return;
        void handle(message);
      });
      log.info({ channel: NOTIFY_CHANNEL }, 'notify subscriber active');
    },
  };
}
