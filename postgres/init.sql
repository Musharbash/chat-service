-- Schema for the chat backend. Intentionally minimal — Postgres only holds:
--   1. Device registry (push tokens, mapping user → devices)
--   2. Spillover queue for undelivered messages that exceeded the Redis TTL
--   3. Idempotency log entries that need to survive a Redis flush
-- Conversation history is NEVER stored here.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS devices (
  device_id      TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  platform       TEXT NOT NULL CHECK (platform IN ('ios','android','web')),
  push_token     TEXT,
  app_version    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS devices_user_idx ON devices(user_id);

CREATE TABLE IF NOT EXISTS undelivered_spill (
  client_id      TEXT PRIMARY KEY,
  sender_id      TEXT NOT NULL,
  recipient_id   TEXT NOT NULL,
  payload        JSONB NOT NULL,
  enqueued_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  delivery_attempts INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS undelivered_recipient_idx ON undelivered_spill(recipient_id, enqueued_at);
CREATE INDEX IF NOT EXISTS undelivered_expiry_idx    ON undelivered_spill(expires_at);
