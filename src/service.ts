// Relay core: request lifecycle, Discord dispatch, reply correlation, timeouts,
// restart recovery and bounded catch-up (02_TECHNICAL_DESIGN §4–5).
import { createHash, randomUUID } from 'node:crypto';
import type { RelayConfig } from './config.ts';
import { correlate } from './correlation.ts';
import type { Correlation } from './correlation.ts';
import { SendError } from './discord/types.ts';
import type { DiscordAdapter, IncomingMessage } from './discord/types.ts';
import type { Logger } from './log.ts';
import { BusyError, IN_FLIGHT, Store } from './store/store.ts';
import type { RequestRow, RequestStatus } from './store/store.ts';
import { isTemplateName, renderRequest, requestMarker } from './templates.ts';
import type { TemplateName } from './templates.ts';
import { cleanReply, renderVoiceRequest, statusMessage } from './voice.ts';

export interface ServiceDeps {
  config: RelayConfig;
  store: Store;
  adapter: DiscordAdapter;
  logger: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  /** Sweep interval for timeouts; 0 disables the timer (tests call sweep()). */
  sweepIntervalMs?: number;
}

export type SubmitResult =
  | { kind: 'created'; request: RequestRow }
  | { kind: 'replayed'; request: RequestRow }
  | { kind: 'idempotency_conflict' }
  | { kind: 'busy'; inFlightStatus: RequestStatus | null }
  | { kind: 'not_ready'; problems: string[] };

export interface RequestView {
  request_id: string;
  status: RequestStatus;
  target_label: string;
  template: string;
  created_at: string;
  sent_at: string | null;
  first_reply_at: string | null;
  completed_at: string | null;
  timed_out_at: string | null;
  discord_request_message_id: string | null;
  reply_parts: { discord_message_id: string; text: string | null; edited_at: string | null; part_index: number; match_basis: string; late: boolean }[];
  error_code: string | null;
  late_reply_available: boolean;
  multipart_detected: boolean;
  /** P0: "completed" means a correlated reply message was received, not that the OpenClaw run finished. */
  completion_basis: 'first_correlated_message' | null;
  run_completion: 'unverified';
}

/** P1: what a free-text request records in the `template` column. Not a valid template name. */
export const FREE_TEXT = 'free_text';
/** P1: identical text from the same principal without an Idempotency-Key within this window is the same request
 *  (Even AI reportedly sends every request twice ~5 ms apart; Shortcuts may retry). */
export const DEDUP_WINDOW_MS = 30_000;

export interface AskView {
  request_id: string;
  status: RequestStatus;
  /** false while the request is still in flight; poll GET /v1/ask/{id}?wait=… */
  done: boolean;
  reply_available: boolean;
  /** Display text: Chris's reply without the echoed request ID and markdown, or a Korean status line. */
  reply: string;
  late_reply: boolean;
  error_code: string | null;
}

const MAX_429_RETRIES = 5;
const CATCHUP_LIMIT = 100;
const RECOVERY_SCAN_LIMIT = 50;

export function bodyHash(target: string, template: string): string {
  return createHash('sha256').update(JSON.stringify({ target, template, arguments: {} })).digest('hex');
}

export function textHash(target: string, text: string): string {
  return createHash('sha256').update(JSON.stringify({ target, kind: FREE_TEXT, text })).digest('hex');
}

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

export class RelayService {
  private readonly cfg: RelayConfig;
  private readonly store: Store;
  private readonly adapter: DiscordAdapter;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newId: () => string;
  private readonly sweepIntervalMs: number;
  private readinessProblems: string[] = ['not_started'];
  private pending = new Set<Promise<unknown>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private waitsAborted = false;

  constructor(d: ServiceDeps) {
    this.cfg = d.config;
    this.store = d.store;
    this.adapter = d.adapter;
    this.log = d.logger;
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.newId = d.newId ?? randomUUID;
    this.sweepIntervalMs = d.sweepIntervalMs ?? 1000;
  }

  // ---- lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    const r = await this.adapter.checkReadiness();
    this.readinessProblems = r.problems;
    if (!r.ready) this.log.warn('readiness_failed', { problems: r.problems });
    await this.adapter.start({
      onMessage: (m) => this.handleMessage(m),
      onConnected: () => {
        this.log.info('discord_connected');
        this.track(this.catchUp());
      },
      onDisconnected: (reason) => this.log.warn('discord_disconnected', { reason }),
    });
    this.recoverOnStart();
    if (this.sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
      this.sweepTimer.unref();
    }
    this.log.info('relay_started', { mode: this.cfg.mode, ready: this.isReady() });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.idle();
    await this.adapter.stop();
    this.log.info('relay_stopped');
  }

  isReady(): boolean {
    return this.readinessProblems.length === 0 && this.adapter.isConnected();
  }

  readiness(): { ready: boolean; problems: string[]; connected: boolean } {
    return { ready: this.isReady(), problems: [...this.readinessProblems], connected: this.adapter.isConnected() };
  }

  /** Resolves when all background dispatch/catch-up work has settled (tests). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private track(p: Promise<unknown>): void {
    const q = p.catch((e) => this.log.error('background_error', { error: String(e) })).finally(() => this.pending.delete(q));
    this.pending.add(q);
  }

  // ---- API-facing -----------------------------------------------------------

  submit(principalId: string, idempotencyKey: string, target: string, template: TemplateName): SubmitResult {
    return this.submitCore(principalId, idempotencyKey, target, template, bodyHash(target, template), null, (id) =>
      renderRequest({ requestId: id, principalId, chrisBotId: this.cfg.chrisBotId, template }),
    );
  }

  /**
   * P1 free text (already normalised by voice.ts). Without an Idempotency-Key, an identical
   * text from the same principal within DEDUP_WINDOW_MS returns the earlier request.
   */
  submitText(principalId: string, idempotencyKey: string | null, target: string, text: string): SubmitResult {
    const since = idempotencyKey ? null : this.now() - DEDUP_WINDOW_MS;
    return this.submitCore(principalId, idempotencyKey ?? `auto-${randomUUID()}`, target, FREE_TEXT, textHash(target, text), since, (id) =>
      renderVoiceRequest({ requestId: id, principalId, chrisBotId: this.cfg.chrisBotId, text, ownerTitle: this.cfg.ownerTitle }),
    );
  }

  private submitCore(
    principalId: string,
    idempotencyKey: string,
    target: string,
    template: string,
    hash: string,
    dedupSince: number | null,
    render: (id: string) => string,
  ): SubmitResult {
    const existing = this.store.findByIdempotency(principalId, idempotencyKey);
    if (existing) return existing.body_hash === hash ? { kind: 'replayed', request: existing } : { kind: 'idempotency_conflict' };
    const recent = () => (dedupSince === null ? undefined : this.store.findRecentSame(principalId, hash, dedupSince));
    const dup = recent();
    if (dup) return { kind: 'replayed', request: dup };
    if (!this.isReady()) return { kind: 'not_ready', problems: this.readiness().problems };

    const id = this.newId();
    const now = this.now();
    let request: RequestRow;
    try {
      request = this.store.tx(() => {
        // Re-check inside the write transaction (concurrent identical POSTs).
        const again = this.store.findByIdempotency(principalId, idempotencyKey) ?? recent();
        if (again) return again;
        return this.store.insertAccepted(
          {
            id,
            principal_id: principalId,
            idempotency_key: idempotencyKey,
            body_hash: hash,
            target,
            channel_id: this.cfg.channelId,
            template,
            rendered_text: render(id),
            nonce: id.replace(/-/g, '').slice(0, 25),
          },
          now,
        );
      });
    } catch (e) {
      if (e instanceof BusyError) {
        const inflight = this.store.listByStatus(IN_FLIGHT).find((r) => r.target === target);
        // A concurrent duplicate (same principal + text, no key) lost the insert race: same request.
        if (dedupSince !== null && inflight && inflight.principal_id === principalId && inflight.body_hash === hash && inflight.created_at >= dedupSince) {
          return { kind: 'replayed', request: inflight };
        }
        return { kind: 'busy', inFlightStatus: inflight?.status ?? null };
      }
      throw e;
    }
    if (request.id !== id) return request.body_hash === hash ? { kind: 'replayed', request } : { kind: 'idempotency_conflict' };
    this.log.info('request_accepted', { request_id: id, template });
    this.track(this.dispatch(id));
    return { kind: 'created', request };
  }

  /** Long-poll helper: resolves when the request leaves the in-flight states, `ms` elapse, or the client goes away. */
  async waitWhileInFlight(id: string, ms: number, aborted: () => boolean = () => false): Promise<void> {
    const end = Date.now() + ms;
    for (;;) {
      if (this.waitsAborted || aborted()) return;
      const r = this.store.get(id);
      if (!r || !IN_FLIGHT.includes(r.status) || Date.now() >= end) return;
      await new Promise((res) => setTimeout(res, 200));
    }
  }

  /** Called on shutdown so pending long-polls answer immediately. */
  abortWaits(): void {
    this.waitsAborted = true;
  }

  /** Principal-scoped display view for voice clients. */
  askView(principalId: string, id: string): AskView | undefined {
    const r = this.store.get(id);
    if (!r || r.principal_id !== principalId) return undefined;
    const parts = this.store.parts(id).filter((p) => p.text);
    const text = parts.length ? cleanReply(parts.map((p) => p.text).join('\n'), r.id) : '';
    return {
      request_id: r.id,
      status: r.status,
      done: !IN_FLIGHT.includes(r.status),
      reply_available: text.length > 0,
      reply: text || statusMessage(r.status, r.error_code) || 'Chris의 답에 표시할 내용이 없습니다. Discord에서 확인해 주세요.',
      late_reply: parts.some((p) => p.late === 1),
      error_code: r.error_code,
    };
  }

  /** Principal-scoped read. Returns undefined for unknown IDs and other principals' IDs alike. */
  view(principalId: string, id: string): RequestView | undefined {
    const r = this.store.get(id);
    if (!r || r.principal_id !== principalId) return undefined;
    const parts = this.store.parts(id);
    return {
      request_id: r.id,
      status: r.status,
      target_label: r.target,
      template: r.template,
      created_at: iso(r.created_at)!,
      sent_at: iso(r.sent_at),
      first_reply_at: iso(r.first_reply_at),
      completed_at: iso(r.completed_at),
      timed_out_at: iso(r.timed_out_at),
      discord_request_message_id: r.discord_message_id,
      reply_parts: parts.map((p) => ({
        discord_message_id: p.discord_message_id,
        text: p.text,
        edited_at: p.edited_at,
        part_index: p.part_index,
        match_basis: p.match_basis,
        late: p.late === 1,
      })),
      error_code: r.error_code,
      late_reply_available: parts.some((p) => p.late === 1),
      multipart_detected: r.multipart_detected === 1,
      completion_basis: r.status === 'completed' ? 'first_correlated_message' : null,
      run_completion: 'unverified',
    };
  }

  // ---- dispatch -------------------------------------------------------------

  private async dispatch(id: string): Promise<void> {
    // Persist "sending" BEFORE touching the network: after a crash, "sending" means
    // "maybe posted" and is never blindly re-sent.
    if (!this.store.transition(id, ['accepted'], 'sending', this.now(), { send_started_at: this.now() })) return;
    const r = this.store.get(id)!;
    for (let attempt = 0; ; attempt++) {
      if (this.stopped) {
        this.store.transition(id, ['sending'], 'delivery_unknown', this.now(), { error_code: 'stopped_during_send' });
        return;
      }
      try {
        const { messageId } = await this.adapter.send({
          channelId: r.channel_id,
          content: r.rendered_text ?? '',
          mentionUserId: this.cfg.chrisBotId,
          nonce: r.nonce,
          silent: r.template === FREE_TEXT,
        });
        const now = this.now();
        this.store.transition(id, ['sending', 'delivery_unknown'], 'awaiting_reply', now, {
          discord_message_id: messageId,
          sent_at: now,
          deadline_at: now + this.cfg.replyTimeoutMs,
          error_code: null,
        });
        this.log.info('request_posted', { request_id: id, discord_message_id: messageId });
        return;
      } catch (e) {
        if (e instanceof SendError && e.kind === 'rate_limited' && attempt < MAX_429_RETRIES) {
          this.store.event(id, this.now(), 'rate_limited', `retry_after_ms=${e.retryAfterMs}`);
          this.log.warn('discord_rate_limited', { request_id: id, retry_after_ms: e.retryAfterMs });
          await this.sleep(Math.max(e.retryAfterMs, 0));
          continue;
        }
        if (e instanceof SendError && e.kind === 'unknown') {
          this.store.transition(id, ['sending'], 'delivery_unknown', this.now(), { error_code: e.code });
          this.log.warn('delivery_unknown', { request_id: id, code: e.code });
          this.track(this.recoverOwnPost(id));
          return;
        }
        const code = e instanceof SendError ? e.code : 'pre_send_exception';
        this.store.transition(id, ['sending'], 'failed', this.now(), { error_code: e instanceof SendError && e.kind === 'rate_limited' ? 'rate_limit_retries_exhausted' : code });
        this.log.warn('request_failed', { request_id: id, code });
        return;
      }
    }
  }

  /**
   * Bounded scan of recent channel history for the relay bot's own post carrying
   * this request's marker. Never re-posts. If not found, the request stays
   * delivery_unknown and needs an operator decision (OPERATIONS.md).
   */
  private async recoverOwnPost(id: string): Promise<void> {
    const r = this.store.get(id);
    if (!r || r.status !== 'delivery_unknown' || !this.adapter.isConnected()) return;
    let msgs: IncomingMessage[];
    try {
      msgs = await this.adapter.fetchMessages(r.channel_id, { limit: RECOVERY_SCAN_LIMIT });
    } catch (e) {
      this.log.warn('recovery_scan_failed', { request_id: id, error: String(e) });
      return;
    }
    const own = msgs.find((m) => m.authorId === this.cfg.relayBotId && m.content.includes(requestMarker(id)));
    if (own) {
      const now = this.now();
      this.store.transition(id, ['delivery_unknown'], 'awaiting_reply', now, {
        discord_message_id: own.id,
        sent_at: r.sent_at ?? now,
        deadline_at: now + this.cfg.replyTimeoutMs,
        error_code: null,
      }, 'recovered_own_post');
      this.log.info('delivery_confirmed_by_scan', { request_id: id, discord_message_id: own.id });
    } else {
      this.store.event(id, this.now(), 'recovery_scan_no_match');
      this.log.warn('operator_check_required', { request_id: id, reason: 'own_post_not_found' });
    }
    // Replies may already be in history (by request ID text).
    for (const m of msgs) this.handleMessage(m);
  }

  // ---- restart recovery & catch-up -----------------------------------------

  private recoverOnStart(): void {
    for (const r of this.store.listByStatus(IN_FLIGHT)) {
      if (r.status === 'accepted') {
        // Never attempted (sending is persisted before the network call).
        this.track(this.dispatch(r.id));
      } else if (r.status === 'sending') {
        this.store.transition(r.id, ['sending'], 'delivery_unknown', this.now(), { error_code: 'interrupted_during_send' }, 'restart');
        this.track(this.recoverOwnPost(r.id));
      } else if (r.status === 'delivery_unknown') {
        this.track(this.recoverOwnPost(r.id));
      }
      // awaiting_reply: kept as-is; catch-up runs on connect.
    }
  }

  /** Bounded REST catch-up for replies missed while the gateway was down. */
  private async catchUp(): Promise<void> {
    for (const r of this.store.listByStatus(['awaiting_reply', 'delivery_unknown'])) {
      try {
        if (r.status === 'delivery_unknown') {
          await this.recoverOwnPost(r.id);
          continue;
        }
        if (!r.discord_message_id) continue;
        const msgs = await this.adapter.fetchMessages(r.channel_id, { afterId: r.discord_message_id, limit: CATCHUP_LIMIT });
        for (const m of msgs) this.handleMessage(m);
      } catch (e) {
        this.log.warn('catchup_failed', { request_id: r.id, error: String(e) });
      }
    }
  }

  // ---- timeouts -------------------------------------------------------------

  sweep(): void {
    const now = this.now();
    for (const r of this.store.listByStatus(['awaiting_reply'])) {
      if (r.deadline_at === null || r.deadline_at > now) continue;
      if (r.ambiguous_candidates > 0) {
        this.store.transition(r.id, ['awaiting_reply'], 'ambiguous_response', now, { error_code: 'uncorrelated_reply_candidates' });
        this.log.warn('request_ambiguous', { request_id: r.id, candidates: r.ambiguous_candidates });
      } else {
        this.store.transition(r.id, ['awaiting_reply'], 'timed_out', now, { timed_out_at: now, error_code: 'reply_timeout' });
        this.log.warn('request_timed_out', { request_id: r.id });
      }
    }
  }

  // ---- inbound --------------------------------------------------------------

  handleMessage(m: IncomingMessage): void {
    const now = this.now();
    const key = m.type === 'create' ? `c:${m.id}` : `u:${m.id}:${m.editedTimestamp ?? ''}`;
    if (!this.store.markProcessed(key, now)) return; // duplicate gateway/catch-up event

    // Edits of an already-attached reply update that part only.
    if (m.type === 'update') {
      const part = this.store.part(m.id);
      if (part) {
        if (m.content) this.store.updatePartText(m.id, m.content, m.editedTimestamp);
        this.store.event(part.request_id, now, 'reply_edited', m.id);
        return;
      }
      // Fallthrough: an edit may add the request ID to a previously unmatched message.
    }

    const c = correlate(m, {
      guildId: this.cfg.guildId,
      channelId: this.cfg.channelId,
      chrisBotId: this.cfg.chrisBotId,
      relayBotId: this.cfg.relayBotId,
      requestByDiscordMessage: (id) => this.store.getByDiscordMessage(id),
      requestById: (id) => {
        const r = this.store.get(id);
        return r && r.channel_id === this.cfg.channelId ? r : undefined;
      },
    });
    this.applyCorrelation(m, c, now);
  }

  private applyCorrelation(m: IncomingMessage, c: Correlation, now: number): void {
    if (c.kind === 'ignore') {
      if (c.reason !== 'self_author') this.store.recordUnmatched({ messageId: m.id, authorId: m.authorId, channelId: m.channelId, reason: c.reason }, now);
      return;
    }
    if (c.kind === 'ambiguous') {
      // Never attach. Count as a candidate against awaiting requests so a timeout
      // becomes ambiguous_response rather than a plain timeout.
      const awaiting = this.store.listByStatus(['awaiting_reply', 'delivery_unknown']).filter((r) => r.channel_id === m.channelId);
      const related = c.requestIds.length ? awaiting.filter((r) => c.requestIds.includes(r.id)) : awaiting;
      for (const r of related) this.store.update(r.id, now, { ambiguous_candidates: r.ambiguous_candidates + 1 });
      this.store.recordUnmatched({ messageId: m.id, authorId: m.authorId, channelId: m.channelId, reason: c.reason, relatedRequestId: related[0]?.id ?? null }, now);
      this.log.warn('reply_ambiguous', { discord_message_id: m.id, reason: c.reason });
      return;
    }

    const r = this.store.get(c.requestId)!;
    if (this.store.part(m.id)) return;
    const hasContent = m.content.trim().length > 0;
    const existing = this.store.parts(r.id);

    this.store.tx(() => {
      const late = r.status === 'timed_out' || r.status === 'ambiguous_response' || r.status === 'failed';
      this.store.insertPart({
        discord_message_id: m.id,
        request_id: r.id,
        part_index: existing.length,
        author_id: m.authorId,
        channel_id: m.channelId,
        text: hasContent ? m.content : null,
        match_basis: c.basis,
        late: late ? 1 : 0,
        received_at: now,
        edited_at: m.editedTimestamp,
      });
      if (late) {
        this.store.event(r.id, now, 'late_reply', m.id);
        return;
      }
      if (r.status === 'completed') {
        this.store.update(r.id, now, { multipart_detected: 1 });
        this.store.event(r.id, now, 'extra_part_unsupported_in_p0', m.id);
        return;
      }
      if (!hasContent) {
        // AT-10: an empty body (e.g. Message Content Intent missing) is never a success.
        this.store.transition(r.id, ['awaiting_reply', 'delivery_unknown', 'sending'], 'failed', now, { error_code: 'reply_content_unavailable', first_reply_at: now });
        return;
      }
      this.store.transition(r.id, ['awaiting_reply', 'delivery_unknown', 'sending'], 'completed', now, { completed_at: now, first_reply_at: now }, c.basis);
    });
    this.log.info('reply_correlated', { request_id: r.id, discord_message_id: m.id, basis: c.basis });
  }

  // ---- operator -------------------------------------------------------------

  purge(): { textsCleared: number; requestsDeleted: number } {
    return this.store.purge(this.now(), this.cfg.textRetentionDays, this.cfg.metadataRetentionDays);
  }
}

export { isTemplateName };
