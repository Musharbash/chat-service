import type { Redis } from 'ioredis';
import { RedisKeys } from '@artook/chat-shared';

// Presence model:
//   - user:sockets:<userId>  → SET of socketIds currently connected (across all gateway replicas)
//   - socket:user:<socketId> → reverse lookup so disconnect can decrement
//   - presence:<userId>      → 'online' marker with last-seen TTL (refreshed on heartbeat)
//
// A user is considered "online" iff the sockets set is non-empty.
// We deliberately do NOT broadcast presence on every socket churn — only when
// the set goes 0→1+ (came online) or 1→0 (went offline). That cuts fan-out.

const PRESENCE_TTL_SECONDS = 60; // refresh on heartbeat

export class PresenceTracker {
  constructor(private readonly r: Redis) {}

  /** Returns true iff this socket caused the user's online-set to transition 0→1. */
  async addSocket(userId: string, socketId: string): Promise<boolean> {
    const key = RedisKeys.socketsByUser(userId);
    // Pipelined for round-trip economy.
    const pipe = this.r.multi();
    pipe.sadd(key, socketId);
    pipe.set(RedisKeys.userBySocket(socketId), userId, 'EX', 24 * 3600);
    pipe.scard(key);
    pipe.set(RedisKeys.presence(userId), '1', 'EX', PRESENCE_TTL_SECONDS);
    const res = await pipe.exec();
    if (!res) return false;
    const cardinality = res[2][1] as number;
    return cardinality === 1;
  }

  /** Returns true iff removing this socket transitioned the user 1→0 (now offline). */
  async removeSocket(socketId: string): Promise<{ userId: string | null; nowOffline: boolean }> {
    const userId = await this.r.get(RedisKeys.userBySocket(socketId));
    if (!userId) return { userId: null, nowOffline: false };
    const pipe = this.r.multi();
    pipe.srem(RedisKeys.socketsByUser(userId), socketId);
    pipe.del(RedisKeys.userBySocket(socketId));
    pipe.scard(RedisKeys.socketsByUser(userId));
    const res = await pipe.exec();
    if (!res) return { userId, nowOffline: false };
    const remaining = res[2][1] as number;
    if (remaining === 0) {
      await this.r.del(RedisKeys.presence(userId));
    }
    return { userId, nowOffline: remaining === 0 };
  }

  /** Heartbeat — extend presence TTL while user remains connected. */
  async touch(userId: string): Promise<void> {
    await this.r.set(RedisKeys.presence(userId), '1', 'EX', PRESENCE_TTL_SECONDS);
  }

  /** Cheap online check. */
  async isOnline(userId: string): Promise<boolean> {
    const n = await this.r.scard(RedisKeys.socketsByUser(userId));
    return n > 0;
  }

  /** Bulk online check used by presence:subscribe handler. */
  async bulkOnline(userIds: string[]): Promise<Record<string, boolean>> {
    if (userIds.length === 0) return {};
    const pipe = this.r.multi();
    for (const id of userIds) pipe.scard(RedisKeys.socketsByUser(id));
    const res = await pipe.exec();
    const out: Record<string, boolean> = {};
    userIds.forEach((id, i) => {
      const n = (res?.[i]?.[1] as number) ?? 0;
      out[id] = n > 0;
    });
    return out;
  }
}
