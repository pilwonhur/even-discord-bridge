// Ordered, append-only schema migrations. Never edit an applied migration.

export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE requests (
  id                   TEXT PRIMARY KEY,
  principal_id         TEXT NOT NULL,
  idempotency_key      TEXT NOT NULL,
  body_hash            TEXT NOT NULL,
  target               TEXT NOT NULL,
  channel_id           TEXT NOT NULL,
  template             TEXT NOT NULL,
  rendered_text        TEXT,
  status               TEXT NOT NULL,
  nonce                TEXT NOT NULL,
  discord_message_id   TEXT,
  error_code           TEXT,
  ambiguous_candidates INTEGER NOT NULL DEFAULT 0,
  multipart_detected   INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  send_started_at      INTEGER,
  sent_at              INTEGER,
  deadline_at          INTEGER,
  first_reply_at       INTEGER,
  completed_at         INTEGER,
  timed_out_at         INTEGER,
  UNIQUE (principal_id, idempotency_key)
);
-- FR-07: at most one in-flight request per target, enforced by the database.
CREATE UNIQUE INDEX requests_one_inflight ON requests(target)
  WHERE status IN ('accepted','sending','awaiting_reply','delivery_unknown');
CREATE UNIQUE INDEX requests_discord_msg ON requests(discord_message_id)
  WHERE discord_message_id IS NOT NULL;

CREATE TABLE reply_parts (
  discord_message_id TEXT PRIMARY KEY,
  request_id         TEXT NOT NULL REFERENCES requests(id),
  part_index         INTEGER NOT NULL,
  author_id          TEXT NOT NULL,
  channel_id         TEXT NOT NULL,
  text               TEXT,
  match_basis        TEXT NOT NULL,
  late               INTEGER NOT NULL DEFAULT 0,
  received_at        INTEGER NOT NULL,
  edited_at          TEXT
);
CREATE INDEX reply_parts_request ON reply_parts(request_id);

-- Discord event de-duplication (AT-13).
CREATE TABLE processed_events (
  event_key   TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);

-- Metadata only (no message text) for events that were not attached to a request.
CREATE TABLE unmatched_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_message_id TEXT NOT NULL,
  author_id          TEXT,
  channel_id         TEXT,
  reason             TEXT NOT NULL,
  related_request_id TEXT,
  received_at        INTEGER NOT NULL
);

-- State transition timeline (FR-13 observability evidence).
CREATE TABLE request_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  at         INTEGER NOT NULL,
  event      TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX request_events_request ON request_events(request_id);
`,
  },
  {
    version: 2,
    sql: `
-- P1-02 device pairing. Only token hashes are stored; the token itself is shown once to the device.
CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at   INTEGER
);
CREATE TABLE pairings (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL,
  claim_sha256 TEXT NOT NULL,
  status       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  approved_at  INTEGER,
  device_id    TEXT
);
-- P1-03 transcripts (text only; audio is never stored). Text follows the request text retention.
CREATE TABLE transcripts (
  id           TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  text         TEXT,
  audio_ms     INTEGER NOT NULL,
  stt_ms       INTEGER NOT NULL,
  model        TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
`,
  },
];
