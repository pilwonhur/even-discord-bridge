// Minimal real Discord adapter: REST v10 via fetch + Gateway via the built-in
// WebSocket. NOT yet verified against live Discord (see docs/test-report.md).
// The bot token is only placed in the Authorization header / IDENTIFY payload and
// is never logged.
import type { Logger } from '../log.ts';
import { SendError } from './types.ts';
import type { AdapterHandlers, DiscordAdapter, IncomingMessage, Readiness, SendParams } from './types.ts';

const API = 'https://discord.com/api/v10';
const UA = 'DiscordBot (https://example.invalid/even-discord-bridge, 0.1.0)';
// GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);
const FLAG_MESSAGE_CONTENT = 1 << 18;
const FLAG_MESSAGE_CONTENT_LIMITED = 1 << 19;
const P = { ADMINISTRATOR: 1n << 3n, VIEW_CHANNEL: 1n << 10n, SEND_MESSAGES: 1n << 11n, READ_MESSAGE_HISTORY: 1n << 16n };
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const NOT_SENT_CAUSES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED']);

/** Discord message flag 1<<12: "@silent" message (no push or desktop notification). */
const FLAG_SUPPRESS_NOTIFICATIONS = 1 << 12;

export interface RealDiscordOptions {
  token: string;
  guildId: string;
  channelId: string;
  relayBotId: string;
  chrisBotId: string;
  logger: Logger;
  requestTimeoutMs?: number;
}

type Json = Record<string, any>;

export class RealDiscord implements DiscordAdapter {
  private readonly o: RealDiscordOptions;
  private h: AdapterHandlers | null = null;
  private ws: WebSocket | null = null;
  private connected = false;
  private stopping = false;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private hbAcked = true;
  private backoffMs = 1000;
  fatal: string | null = null;

  constructor(o: RealDiscordOptions) {
    this.o = o;
  }

  // ---- REST -----------------------------------------------------------------

  private async rest(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(API + path, {
      method,
      headers: { authorization: `Bot ${this.o.token}`, 'user-agent': UA, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.o.requestTimeoutMs ?? 15_000),
    });
  }

  private async getJson(path: string): Promise<{ status: number; body: any }> {
    const res = await this.rest('GET', path);
    let body: any = null;
    try {
      body = await res.json();
    } catch {}
    return { status: res.status, body };
  }

  async checkReadiness(): Promise<Readiness> {
    const problems: string[] = [];
    try {
      const me = await this.getJson('/users/@me');
      if (me.status === 401) return { ready: false, problems: ['bot_token_invalid'] };
      if (me.body?.id !== this.o.relayBotId) problems.push('relay_bot_id_mismatch');

      const app = await this.getJson('/applications/@me');
      const flags = Number(app.body?.flags ?? 0);
      if (!(flags & (FLAG_MESSAGE_CONTENT | FLAG_MESSAGE_CONTENT_LIMITED))) problems.push('message_content_intent_missing');

      const ch = await this.getJson(`/channels/${this.o.channelId}`);
      if (ch.status !== 200) problems.push(`channel_unreadable_http_${ch.status}`);
      else {
        if (ch.body.guild_id !== this.o.guildId) problems.push('channel_guild_mismatch');
        if (ch.body.type !== 0) problems.push('channel_not_guild_text');
      }

      const chris = await this.getJson(`/guilds/${this.o.guildId}/members/${this.o.chrisBotId}`);
      if (chris.status !== 200) problems.push(`chris_not_member_http_${chris.status}`);
      else if (chris.body?.user?.bot !== true) problems.push('chris_id_is_not_a_bot');

      const member = await this.getJson(`/guilds/${this.o.guildId}/members/${this.o.relayBotId}`);
      const roles = await this.getJson(`/guilds/${this.o.guildId}/roles`);
      if (member.status === 200 && roles.status === 200 && ch.status === 200) {
        const perms = computePermissions(this.o.guildId, member.body.roles ?? [], roles.body, ch.body.permission_overwrites ?? [], this.o.relayBotId);
        if (perms.admin) problems.push('relay_bot_has_administrator');
        for (const [name, bit] of [['view_channel', P.VIEW_CHANNEL], ['send_messages', P.SEND_MESSAGES], ['read_message_history', P.READ_MESSAGE_HISTORY]] as const) {
          if (!(perms.value & bit)) problems.push(`missing_permission_${name}`);
        }
      } else problems.push('permissions_unverifiable');
    } catch (e) {
      problems.push(`readiness_check_error:${(e as Error).name}`);
    }
    return { ready: problems.length === 0, problems };
  }

  async send(p: SendParams): Promise<{ messageId: string }> {
    let res: Response;
    try {
      res = await this.rest('POST', `/channels/${p.channelId}/messages`, {
        content: p.content,
        allowed_mentions: { parse: [], users: [p.mentionUserId], replied_user: false },
        nonce: p.nonce,
        enforce_nonce: true,
        ...(p.silent ? { flags: FLAG_SUPPRESS_NOTIFICATIONS } : {}),
      });
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause?.code ?? '';
      if (NOT_SENT_CAUSES.has(cause)) throw new SendError('not_sent', `network_${cause}`);
      throw new SendError('unknown', `network_${cause || (e as Error).name}`);
    }
    if (res.status === 200 || res.status === 201) {
      const body = (await res.json()) as Json;
      return { messageId: String(body.id) };
    }
    let body: Json = {};
    try {
      body = (await res.json()) as Json;
    } catch {}
    if (res.status === 429) {
      const sec = Number(body.retry_after ?? res.headers.get('retry-after') ?? 1);
      throw new SendError('rate_limited', 'http_429', Math.ceil(sec * 1000));
    }
    if (res.status >= 500) throw new SendError('unknown', `http_${res.status}`);
    throw new SendError('not_sent', `http_${res.status}_${body.code ?? 'unknown'}`);
  }

  async fetchMessages(channelId: string, opts: { afterId?: string; limit: number }): Promise<IncomingMessage[]> {
    const q = new URLSearchParams({ limit: String(Math.min(Math.max(opts.limit, 1), 100)) });
    if (opts.afterId) q.set('after', opts.afterId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.rest('GET', `/channels/${channelId}/messages?${q}`);
      if (res.status === 429) {
        const b = (await res.json().catch(() => ({}))) as Json;
        await new Promise((r) => setTimeout(r, Math.ceil(Number(b.retry_after ?? 1) * 1000)));
        continue;
      }
      if (res.status !== 200) throw new Error(`fetch_messages_http_${res.status}`);
      const list = (await res.json()) as Json[];
      return list
        .map((m) => toIncoming(m, 'create', this.o.guildId))
        .filter((m): m is IncomingMessage => m !== null)
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    }
    throw new Error('fetch_messages_rate_limited');
  }

  // ---- Gateway --------------------------------------------------------------

  isConnected(): boolean {
    return this.connected;
  }

  async start(h: AdapterHandlers): Promise<void> {
    this.h = h;
    this.stopping = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.connected = false;
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.ws?.close(1000);
    this.ws = null;
  }

  private async connect(): Promise<void> {
    if (this.stopping || this.fatal) return;
    let url = this.resumeUrl;
    if (!url || !this.sessionId) {
      const g = await this.getJson('/gateway/bot').catch(() => ({ status: 0, body: null }));
      if (g.status !== 200) {
        this.o.logger.warn('gateway_url_unavailable', { status: g.status });
        this.scheduleReconnect();
        return;
      }
      url = String(g.body.url);
    }
    const ws = new WebSocket(`${url}/?v=10&encoding=json`);
    this.ws = ws;
    ws.onmessage = (ev) => this.onPayload(JSON.parse(String(ev.data)) as Json);
    ws.onclose = (ev) => this.onClose(ev.code);
    ws.onerror = () => {};
  }

  private sendWs(op: number, d: unknown): void {
    this.ws?.send(JSON.stringify({ op, d }));
  }

  private onPayload(p: Json): void {
    if (typeof p.s === 'number') this.seq = p.s;
    switch (p.op) {
      case 10: {
        const interval = Number(p.d.heartbeat_interval);
        if (this.hbTimer) clearInterval(this.hbTimer);
        this.hbAcked = true;
        setTimeout(() => this.heartbeat(), Math.floor(interval * Math.random()));
        this.hbTimer = setInterval(() => this.heartbeat(), interval);
        if (this.sessionId && this.seq !== null) {
          this.sendWs(6, { token: this.o.token, session_id: this.sessionId, seq: this.seq });
        } else {
          this.sendWs(2, { token: this.o.token, intents: INTENTS, properties: { os: process.platform, browser: 'even-discord-bridge', device: 'even-discord-bridge' } });
        }
        return;
      }
      case 11:
        this.hbAcked = true;
        return;
      case 1:
        this.sendWs(1, this.seq);
        return;
      case 7:
        this.ws?.close(4900);
        return;
      case 9:
        if (!p.d) {
          this.sessionId = null;
          this.seq = null;
          this.resumeUrl = null;
        }
        setTimeout(() => this.ws?.close(4900), 1000 + Math.random() * 4000);
        return;
      case 0:
        this.onDispatch(String(p.t), p.d as Json);
    }
  }

  private heartbeat(): void {
    if (!this.hbAcked) {
      this.o.logger.warn('gateway_zombie_connection');
      this.ws?.close(4900);
      return;
    }
    this.hbAcked = false;
    this.sendWs(1, this.seq);
  }

  private onDispatch(t: string, d: Json): void {
    if (t === 'READY' || t === 'RESUMED') {
      if (t === 'READY') {
        this.sessionId = String(d.session_id);
        this.resumeUrl = String(d.resume_gateway_url);
      }
      this.connected = true;
      this.backoffMs = 1000;
      this.h?.onConnected();
      return;
    }
    if (t === 'MESSAGE_CREATE' || t === 'MESSAGE_UPDATE') {
      if (d.channel_id !== this.o.channelId) return; // other channels are not read or stored
      const m = toIncoming(d, t === 'MESSAGE_CREATE' ? 'create' : 'update', this.o.guildId);
      if (m) this.h?.onMessage(m);
    }
  }

  private onClose(code: number): void {
    const was = this.connected;
    this.connected = false;
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (was) this.h?.onDisconnected(`close_${code}`);
    if (this.stopping) return;
    if (FATAL_CLOSE.has(code)) {
      this.fatal = `gateway_close_${code}`;
      this.o.logger.error('gateway_fatal_close', { code });
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    setTimeout(() => void this.connect(), wait);
  }
}

function toIncoming(d: Json, type: 'create' | 'update', guildId: string): IncomingMessage | null {
  if (!d?.id || !d.author?.id) return null; // partial updates (e.g. embed-only) are ignored
  return {
    type,
    id: String(d.id),
    channelId: String(d.channel_id),
    guildId: d.guild_id ? String(d.guild_id) : guildId,
    authorId: String(d.author.id),
    authorIsBot: d.author.bot === true,
    content: typeof d.content === 'string' ? d.content : '',
    referenceMessageId: d.message_reference?.message_id ? String(d.message_reference.message_id) : null,
    editedTimestamp: d.edited_timestamp ?? null,
    hasAttachmentsOrEmbeds: (d.attachments?.length ?? 0) > 0 || (d.embeds?.length ?? 0) > 0,
  };
}

/** Discord channel permission computation (guild base + channel overwrites). */
export function computePermissions(
  guildId: string,
  memberRoles: string[],
  roles: { id: string; permissions: string }[],
  overwrites: { id: string; type: number; allow: string; deny: string }[],
  memberId: string,
): { value: bigint; admin: boolean } {
  const roleMap = new Map(roles.map((r) => [r.id, BigInt(r.permissions)]));
  let base = roleMap.get(guildId) ?? 0n;
  for (const r of memberRoles) base |= roleMap.get(r) ?? 0n;
  if (base & P.ADMINISTRATOR) return { value: ~0n, admin: true };
  const everyone = overwrites.find((o) => o.id === guildId);
  if (everyone) base = (base & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites) {
    if (o.type === 0 && memberRoles.includes(o.id)) {
      allow |= BigInt(o.allow);
      deny |= BigInt(o.deny);
    }
  }
  base = (base & ~deny) | allow;
  const mine = overwrites.find((o) => o.type === 1 && o.id === memberId);
  if (mine) base = (base & ~BigInt(mine.deny)) | BigInt(mine.allow);
  return { value: base, admin: false };
}
