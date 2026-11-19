// SQLite persistence (node:sqlite, synchronous). Single-process P0 service.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations.ts';

export type RequestStatus =
  | 'accepted'
  | 'sending'
  | 'awaiting_reply'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'delivery_unknown'
  | 'ambiguous_response';

export const IN_FLIGHT: readonly RequestStatus[] = ['accepted', 'sending', 'awaiting_reply', 'delivery_unknown'];
export const TERMINAL: readonly RequestStatus[] = ['completed', 'failed', 'timed_out', 'ambiguous_response'];

export interface RequestRow {
  id: string;
  principal_id: string;
  idempotency_key: string;
  body_hash: string;
  target: string;
  channel_id: string;
  template: string;
  rendered_text: string | null;
  status: RequestStatus;
  nonce: string;
  discord_message_id: string | null;
  error_code: string | null;
  ambiguous_candidates: number;
  multipart_detected: number;
  created_at: number;
  updated_at: number;
  send_started_at: number | null;
  sent_at: number | null;
  deadline_at: number | null;
  first_reply_at: number | null;
  completed_at: number | null;
  timed_out_at: number | null;
}

export interface ReplyPartRow {
  discord_message_id: string;
  request_id: string;
  part_index: number;
  author_id: string;
  channel_id: string;
  text: string | null;
  match_basis: string;
  late: number;
  received_at: number;
  edited_at: string | null;
}

export interface PairingRow {
  id: string;
  code: string;
  claim_sha256: string;
  status: 'pending' | 'approved' | 'claimed';
  created_at: number;
  expires_at: number;
  approved_at: number | null;
  device_id: string | null;
}

export interface DeviceRow {
  id: string;
  principal_id: string;
  token_sha256: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

export interface TranscriptRow {
  id: string;
  principal_id: string;
  text: string | null;
  audio_ms: number;
  stt_ms: number;
  model: string;
  created_at: number;
}

export class BusyError extends Error {}

type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const applied = new Set((this.db.prepare('SELECT version FROM schema_migrations').all() as Row[]).map((r) => r.version as number));
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.tx(() => {
        this.db.exec(m.sql);
        this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, Date.now());
      });
    }
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- requests -------------------------------------------------------------

  findByIdempotency(principalId: string, key: string): RequestRow | undefined {
    return this.db.prepare('SELECT * FROM requests WHERE principal_id = ? AND idempotency_key = ?').get(principalId, key) as RequestRow | undefined;
  }

  /** Most recent non-failed request with the same principal and body since `since` (P1 duplicate suppression). */
  findRecentSame(principalId: string, bodyHash: string, since: number): RequestRow | undefined {
    return this.db
      .prepare("SELECT * FROM requests WHERE principal_id = ? AND body_hash = ? AND created_at >= ? AND status <> 'failed' ORDER BY created_at DESC LIMIT 1")
      .get(principalId, bodyHash, since) as RequestRow | undefined;
  }

  get(id: string): RequestRow | undefined {
    return this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as RequestRow | undefined;
  }

  getByDiscordMessage(messageId: string): RequestRow | undefined {
    return this.db.prepare('SELECT * FROM requests WHERE discord_message_id = ?').get(messageId) as RequestRow | undefined;
  }

  listByStatus(statuses: readonly RequestStatus[]): RequestRow[] {
    const q = `SELECT * FROM requests WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at`;
    return this.db.prepare(q).all(...statuses) as unknown as RequestRow[];
  }

  listRecent(limit: number): RequestRow[] {
    return this.db.prepare('SELECT * FROM requests ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as RequestRow[];
  }

  /** Inserts a new accepted request. Throws BusyError if the target already has one in flight. */
  insertAccepted(r: Pick<RequestRow, 'id' | 'principal_id' | 'idempotency_key' | 'body_hash' | 'target' | 'channel_id' | 'template' | 'rendered_text' | 'nonce'>, now: number): RequestRow {
    try {
      this.db
        .prepare(
          `INSERT INTO requests (id, principal_id, idempotency_key, body_hash, target, channel_id, template, rendered_text, status, nonce, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?)`,
        )
        .run(r.id, r.principal_id, r.idempotency_key, r.body_hash, r.target, r.channel_id, r.template, r.rendered_text, r.nonce, now, now);
    } catch (e) {
      const msg = String((e as Error).message);
      if (msg.includes('requests.target') || msg.includes('requests_one_inflight')) throw new BusyError('target busy');
      throw e;
    }
    this.event(r.id, now, 'accepted');
    return this.get(r.id)!;
  }

  /**
   * Compare-and-set status transition. Returns false (and changes nothing) if the
   * request is not currently in one of `from`.
   */
  transition(id: string, from: readonly RequestStatus[], to: RequestStatus, now: number, fields: Partial<RequestRow> = {}, detail?: string): boolean {
    const sets = ['status = ?', 'updated_at = ?'];
    const vals: (string | number | null)[] = [to, now];
    for (const [k, v] of Object.entries(fields)) {
      if (!/^[a-z_]+$/.test(k)) throw new Error('bad column');
      sets.push(`${k} = ?`);
      vals.push(v as string | number | null);
    }
    const q = `UPDATE requests SET ${sets.join(', ')} WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`;
    const res = this.db.prepare(q).run(...vals, id, ...from);
    if (Number(res.changes) === 1) {
      this.event(id, now, to, detail);
      return true;
    }
    return false;
  }

  update(id: string, now: number, fields: Partial<RequestRow>): void {
    const sets = ['updated_at = ?'];
    const vals: (string | number | null)[] = [now];
    for (const [k, v] of Object.entries(fields)) {
      if (!/^[a-z_]+$/.test(k)) throw new Error('bad column');
      sets.push(`${k} = ?`);
      vals.push(v as string | number | null);
    }
    this.db.prepare(`UPDATE requests SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  event(requestId: string, at: number, event: string, detail?: string): void {
    this.db.prepare('INSERT INTO request_events (request_id, at, event, detail) VALUES (?, ?, ?, ?)').run(requestId, at, event, detail ?? null);
  }

  events(requestId: string): { at: number; event: string; detail: string | null }[] {
    return this.db.prepare('SELECT at, event, detail FROM request_events WHERE request_id = ? ORDER BY id').all(requestId) as unknown as {
      at: number;
      event: string;
      detail: string | null;
    }[];
  }

  // ---- reply parts ----------------------------------------------------------

  parts(requestId: string): ReplyPartRow[] {
    return this.db.prepare('SELECT * FROM reply_parts WHERE request_id = ? ORDER BY part_index').all(requestId) as unknown as ReplyPartRow[];
  }

  part(messageId: string): ReplyPartRow | undefined {
    return this.db.prepare('SELECT * FROM reply_parts WHERE discord_message_id = ?').get(messageId) as ReplyPartRow | undefined;
  }

  insertPart(p: ReplyPartRow): void {
    this.db
      .prepare(
        `INSERT INTO reply_parts (discord_message_id, request_id, part_index, author_id, channel_id, text, match_basis, late, received_at, edited_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.discord_message_id, p.request_id, p.part_index, p.author_id, p.channel_id, p.text, p.match_basis, p.late, p.received_at, p.edited_at);
  }

  updatePartText(messageId: string, text: string, editedAt: string | null): void {
    this.db.prepare('UPDATE reply_parts SET text = ?, edited_at = ? WHERE discord_message_id = ?').run(text, editedAt, messageId);
  }

  // ---- discord events -------------------------------------------------------

  /** Returns true the first time an event key is seen. */
  markProcessed(key: string, now: number): boolean {
    const res = this.db.prepare('INSERT OR IGNORE INTO processed_events (event_key, received_at) VALUES (?, ?)').run(key, now);
    return Number(res.changes) === 1;
  }

  recordUnmatched(e: { messageId: string; authorId: string | null; channelId: string | null; reason: string; relatedRequestId?: string | null }, now: number): void {
    this.db
      .prepare('INSERT INTO unmatched_events (discord_message_id, author_id, channel_id, reason, related_request_id, received_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.messageId, e.authorId, e.channelId, e.reason, e.relatedRequestId ?? null, now);
  }

  unmatched(): { discord_message_id: string; author_id: string; reason: string; related_request_id: string | null }[] {
    return this.db.prepare('SELECT discord_message_id, author_id, reason, related_request_id FROM unmatched_events ORDER BY id').all() as never;
  }

  // ---- devices / pairing (P1-02) ------------------------------------------------

  /** Creates a pending pairing with a 6-digit code unique among pending, unexpired pairings. */
  createPairing(p: { id: string; claimSha256: string; now: number; ttlMs: number; code: () => string }): PairingRow {
    return this.tx(() => {
      let code = p.code();
      for (let i = 0; this.activePairingByCode(code, p.now); i++) {
        if (i > 20) throw new Error('pairing_code_exhausted');
        code = p.code();
      }
      this.db
        .prepare("INSERT INTO pairings (id, code, claim_sha256, status, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?)")
        .run(p.id, code, p.claimSha256, p.now, p.now + p.ttlMs);
      return this.pairing(p.id)!;
    });
  }

  pairing(id: string): PairingRow | undefined {
    return this.db.prepare('SELECT * FROM pairings WHERE id = ?').get(id) as PairingRow | undefined;
  }

  countActivePairings(now: number): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM pairings WHERE status = 'pending' AND expires_at > ?").get(now) as Row).n);
  }

  private activePairingByCode(code: string, now: number): PairingRow | undefined {
    return this.db.prepare("SELECT * FROM pairings WHERE code = ? AND status IN ('pending','approved') AND expires_at > ?").get(code, now) as PairingRow | undefined;
  }

  /** Operator approval (`admin pair <code>`). Only a pending, unexpired pairing can be approved. */
  approvePairing(code: string, now: number): PairingRow | undefined {
    const p = this.db.prepare("SELECT * FROM pairings WHERE code = ? AND status = 'pending' AND expires_at > ?").get(code, now) as PairingRow | undefined;
    if (!p) return undefined;
    this.db.prepare("UPDATE pairings SET status = 'approved', approved_at = ? WHERE id = ? AND status = 'pending'").run(now, p.id);
    return this.pairing(p.id);
  }

  /** Single use: approved → claimed and a device row, atomically. */
  claimPairing(id: string, device: { id: string; principalId: string; tokenSha256: string }, now: number): boolean {
    return this.tx(() => {
      const res = this.db.prepare("UPDATE pairings SET status = 'claimed', device_id = ? WHERE id = ? AND status = 'approved' AND expires_at > ?").run(device.id, id, now);
      if (Number(res.changes) !== 1) return false;
      this.db.prepare('INSERT INTO devices (id, principal_id, token_sha256, created_at) VALUES (?, ?, ?, ?)').run(device.id, device.principalId, device.tokenSha256, now);
      return true;
    });
  }

  deviceByTokenHash(sha256Hex: string): DeviceRow | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE token_sha256 = ?').get(sha256Hex) as DeviceRow | undefined;
  }

  touchDevice(id: string, now: number): void {
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)').run(now, id, now - 60_000);
  }

  devices(): DeviceRow[] {
    return this.db.prepare('SELECT * FROM devices ORDER BY created_at').all() as unknown as DeviceRow[];
  }

  revokeDevice(id: string, now: number): boolean {
    return Number(this.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id).changes) === 1;
  }

  // ---- transcripts (P1-03) ------------------------------------------------------

  insertTranscript(t: TranscriptRow): void {
    this.db
      .prepare('INSERT INTO transcripts (id, principal_id, text, audio_ms, stt_ms, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(t.id, t.principal_id, t.text, t.audio_ms, t.stt_ms, t.model, t.created_at);
  }

  transcript(id: string): TranscriptRow | undefined {
    return this.db.prepare('SELECT * FROM transcripts WHERE id = ?').get(id) as TranscriptRow | undefined;
  }

  // ---- retention ------------------------------------------------------------

  /** Clears relay-held texts after textDays and deletes metadata after metaDays. Discord itself is untouched. */
  purge(now: number, textDays: number, metaDays: number): { textsCleared: number; requestsDeleted: number } {
    const day = 86_400_000;
    const textCut = now - textDays * day;
    const metaCut = now - metaDays * day;
    return this.tx(() => {
      const terminal = TERMINAL.map((s) => `'${s}'`).join(',');
      const a = this.db.prepare(`UPDATE requests SET rendered_text = NULL WHERE created_at < ? AND rendered_text IS NOT NULL AND status IN (${terminal})`).run(textCut);
      const b = this.db
        .prepare(`UPDATE reply_parts SET text = NULL WHERE received_at < ? AND text IS NOT NULL AND request_id IN (SELECT id FROM requests WHERE status IN (${terminal}))`)
        .run(textCut);
      const old = `SELECT id FROM requests WHERE created_at < ? AND status IN (${terminal})`;
      this.db.prepare(`DELETE FROM reply_parts WHERE request_id IN (${old})`).run(metaCut);
      this.db.prepare(`DELETE FROM request_events WHERE request_id IN (${old})`).run(metaCut);
      const c = this.db.prepare(`DELETE FROM requests WHERE created_at < ? AND status IN (${terminal})`).run(metaCut);
      this.db.prepare('DELETE FROM unmatched_events WHERE received_at < ?').run(metaCut);
      this.db.prepare('DELETE FROM processed_events WHERE received_at < ?').run(metaCut);
      const t = this.db.prepare('UPDATE transcripts SET text = NULL WHERE created_at < ? AND text IS NOT NULL').run(textCut);
      this.db.prepare('DELETE FROM transcripts WHERE created_at < ?').run(metaCut);
      this.db.prepare("DELETE FROM pairings WHERE status <> 'claimed' AND expires_at < ?").run(now - day);
      return { textsCleared: Number(a.changes) + Number(b.changes) + Number(t.changes), requestsDeleted: Number(c.changes) };
    });
  }
}
