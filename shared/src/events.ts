// Canonical event names used on the Socket.IO transport.
// Mirror this exactly in the Dart client (lib/features/chat/data/service/chat_gateway_events.dart).

export const ClientEvent = {
  MessageSend: 'message:send',
  MessageAck: 'message:ack',
  MessageRecall: 'message:recall',
  PresenceSubscribe: 'presence:subscribe',
  PresenceUnsubscribe: 'presence:unsubscribe',
  Typing: 'typing',
  SyncSince: 'sync:since',
} as const;

export const ServerEvent = {
  MessageNew: 'message:new',
  MessageAckDelivered: 'message:ack:delivered',
  MessageAckRead: 'message:ack:read',
  MessageRecalled: 'message:recalled',
  PresenceUpdate: 'presence:update',
  TypingUpdate: 'typing:update',
  SyncSnapshot: 'sync:snapshot',
} as const;
