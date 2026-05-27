import { z } from 'zod';

// ULID: 26 chars, Crockford base32. Used as the client-generated, server-immutable message id.
// Case-insensitive: the Dart `ulid` package emits lowercase, JavaScript libs typically emit uppercase.
// The ULID spec treats them as equivalent.
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
export const Ulid = z.string().regex(ULID_RE, 'invalid ULID');

// User ids — accept reasonably-shaped opaque strings. Length caps prevent abuse.
export const UserId = z.string().min(1).max(128);
export const DeviceId = z.string().min(1).max(128);

export const MessageType = z.enum(['text', 'image', 'voice']);
export type MessageType = z.infer<typeof MessageType>;

// Bodies are kept narrow on purpose. Add new variants behind a discriminator.
//
// The discriminator field is named `runtimeType` to match Freezed 3.x's
// hardcoded sealed-union JSON layout (Freezed 3 removed the unionKey option).
// Even though `runtimeType` is also a Dart built-in property, in this JSON
// envelope it's just a literal string key.
export const TextBody = z.object({
  runtimeType: z.literal('text'),
  text: z.string().min(1).max(4000),
});

// .nullish() instead of .optional() because Flutter's JSON serializer
// emits `"field": null` when a nullable Dart field is null — not absent.
// Zod's .optional() only accepts `undefined` (key missing) and rejects
// explicit `null`, which causes "Expected number, received null"
// validation failures. .nullish() accepts both `undefined` and `null`.
export const ImageBody = z.object({
  runtimeType: z.literal('image'),
  url: z.string().url(),
  width: z.number().int().positive().max(8192).nullish(),
  height: z.number().int().positive().max(8192).nullish(),
  bytes: z.number().int().positive().max(20 * 1024 * 1024).nullish(),
  mime: z.string().max(64).nullish(),
});

export const VoiceBody = z.object({
  runtimeType: z.literal('voice'),
  url: z.string().url(),
  durationMs: z.number().int().positive().max(10 * 60 * 1000),
  bytes: z.number().int().positive().max(20 * 1024 * 1024).nullish(),
});

// Video posts from the chat gallery picker. The client tap-opens the URL
// in the system player; no inline preview on the server side (the
// recipient renders a placeholder tile with size + duration + play icon).
export const VideoBody = z.object({
  runtimeType: z.literal('video'),
  url: z.string().url(),
  durationMs: z.number().int().positive().max(60 * 60 * 1000).nullish(),
  width: z.number().int().positive().max(8192).nullish(),
  height: z.number().int().positive().max(8192).nullish(),
  bytes: z.number().int().positive().max(200 * 1024 * 1024).nullish(),
  mime: z.string().max(64).nullish(),
});

// Arbitrary file attachment (PDF, doc, zip, etc). Mirrors what the
// /v1/upload endpoint accepts with kind='file'. The client renders a
// card with the file name, size and type — no inline preview.
export const FileBody = z.object({
  runtimeType: z.literal('file'),
  url: z.string().url(),
  name: z.string().min(1).max(256),
  bytes: z.number().int().positive().max(50 * 1024 * 1024).nullish(),
  mime: z.string().max(128).nullish(),
});

export const MessageBody = z.discriminatedUnion('runtimeType', [TextBody, ImageBody, VoiceBody, VideoBody, FileBody]);
export type MessageBody = z.infer<typeof MessageBody>;

// Wire envelope sent by clients with `message:send`. clientId is the durable ULID.
// sentAtMs is the sender's clock — server logs it but uses its own clock for ordering.
export const SendMessageInput = z.object({
  clientId: Ulid,
  to: UserId,
  body: MessageBody,
  sentAtMs: z.number().int().nonnegative(),
});
export type SendMessageInput = z.infer<typeof SendMessageInput>;

// Server-side envelope sent to recipients. serverSeq is monotonic per-recipient.
export const ServerMessage = z.object({
  clientId: Ulid,
  from: UserId,
  to: UserId,
  body: MessageBody,
  sentAtMs: z.number().int().nonnegative(),
  serverAtMs: z.number().int().nonnegative(),
  serverSeq: z.number().int().nonnegative(),
});
export type ServerMessage = z.infer<typeof ServerMessage>;

export const AckKind = z.enum(['delivered', 'read']);
export type AckKind = z.infer<typeof AckKind>;

export const AckInput = z.object({
  clientId: Ulid,
  kind: AckKind,
  // For 'read', the client may pass the conversation peer so the server can mark
  // every prior message from that peer as read in one call.
  conversationPeer: UserId.optional(),
});
export type AckInput = z.infer<typeof AckInput>;

export const RecallInput = z.object({
  clientId: Ulid,
});
export type RecallInput = z.infer<typeof RecallInput>;

export const PresenceSubscribeInput = z.object({
  userIds: z.array(UserId).min(1).max(200),
});

export const TypingInput = z.object({
  to: UserId,
  isTyping: z.boolean(),
});

export const SyncSinceInput = z.object({
  // Cursor: deliver every message with serverSeq > lastServerSeq.
  // 0 = full replay of whatever is still in the undelivered queue.
  lastServerSeq: z.number().int().nonnegative(),
});

// Ack envelope returned by the server on `message:send`.
export const SendAck = z.object({
  ok: z.literal(true),
  serverSeq: z.number().int().nonnegative(),
  serverAtMs: z.number().int().nonnegative(),
});
export type SendAck = z.infer<typeof SendAck>;

export const ErrorAck = z.object({
  ok: z.literal(false),
  code: z.string(),
  message: z.string(),
});
export type ErrorAck = z.infer<typeof ErrorAck>;
