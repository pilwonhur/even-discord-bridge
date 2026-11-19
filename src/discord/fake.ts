// In-memory Discord stand-in with fault injection and a MOCK Chris responder.
// Everything produced here is labelled mock; it is never evidence of a real Chris reply.
import { SendError } from './types.ts';
import type { AdapterHandlers, DiscordAdapter, IncomingMessage, Readiness, SendParams } from './types.ts';

export interface FakeMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  content: string;
  referenceMessageId: string | null;
  editedTimestamp: string | null;
  nonce: string | null;
  silent: boolean;
}

export type MockChrisMode = 'request_id' | 'reference' | 'none' | 'silent';

export interface FakeOptions {
  guildId: string;
  channelId: string;
  relayBotId: string;
  chrisBotId: string;
  messageContentIntent?: boolean;
  readinessProblems?: string[];
  chris?: { mode: MockChrisMode; delayMs?: number };
}

export type SendFault =
  | { kind: 'not_sent' }
  | { kind: 'rate_limited'; retryAfterMs: number }
  /** Discord creates the message, but the HTTP response is lost. */
  | { kind: 'lost_response' }
  /** Outcome unknown to the caller and the message was in fact NOT created. */
  | { kind: 'unknown_without_post' }
  /** Throws synchronously before any network activity. */
  | { kind: 'throw' };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export class FakeDiscord implements DiscordAdapter {
  readonly opts: FakeOptions;
  readonly messages: FakeMessage[] = [];
  readonly sendAttempts: { at: number; nonce: string }[] = [];
  private handlers: AdapterHandlers | null = null;
  private connected = false;
  private faults: SendFault[] = [];
  private seq = 1_600_000_000_000_000_000n;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(opts: FakeOptions) {
    this.opts = { messageContentIntent: true, readinessProblems: [], ...opts };
  }

  // ---- adapter interface ----------------------------------------------------

  async start(h: AdapterHandlers): Promise<void> {
    this.handlers = h;
    this.connected = true;
    h.onConnected();
  }

  async stop(): Promise<void> {
    this.connected = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.handlers = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async checkReadiness(): Promise<Readiness> {
    const problems = [...(this.opts.readinessProblems ?? [])];
    if (!this.opts.messageContentIntent) problems.push('message_content_intent_missing');
    return { ready: problems.length === 0, problems };
  }

  async send(p: SendParams): Promise<{ messageId: string }> {
    this.sendAttempts.push({ at: Date.now(), nonce: p.nonce });
    const fault = this.faults.shift();
    if (fault?.kind === 'throw') throw new Error('fake: exception before send');
    if (fault?.kind === 'not_sent') throw new SendError('not_sent', 'fake_connection_refused');
    if (fault?.kind === 'rate_limited') throw new SendError('rate_limited', 'http_429', fault.retryAfterMs);
    if (fault?.kind === 'unknown_without_post') throw new SendError('unknown', 'fake_timeout');
    if (p.channelId !== this.opts.channelId) throw new SendError('not_sent', 'fake_unknown_channel');
    // enforce_nonce semantics: same nonce within the window returns the existing message.
    const dup = this.messages.find((m) => m.nonce === p.nonce && m.authorId === this.opts.relayBotId);
    if (dup) return { messageId: dup.id };
    const msg = this.post({ authorId: this.opts.relayBotId, authorIsBot: true, content: p.content, nonce: p.nonce, silent: p.silent ?? false });
    this.maybeChrisReply(msg);
    if (fault?.kind === 'lost_response') throw new SendError('unknown', 'fake_response_lost');
    return { messageId: msg.id };
  }

  async fetchMessages(channelId: string, opts: { afterId?: string; limit: number }): Promise<IncomingMessage[]> {
    let list = this.messages.filter((m) => m.channelId === channelId);
    if (opts.afterId) {
      const after = BigInt(opts.afterId);
      list = list.filter((m) => BigInt(m.id) > after).slice(0, opts.limit);
    } else {
      list = list.slice(-opts.limit);
    }
    return list.map((m) => this.toIncoming(m, 'create'));
  }

  // ---- test controls --------------------------------------------------------

  injectFault(f: SendFault): void {
    this.faults.push(f);
  }

  setChrisMode(mode: MockChrisMode, delayMs = 0): void {
    this.opts.chris = { mode, delayMs };
  }

  /** Gateway drop: events posted while disconnected are not delivered, only fetchable. */
  disconnect(reason = 'fake_disconnect'): void {
    this.connected = false;
    this.handlers?.onDisconnected(reason);
  }

  reconnect(): void {
    this.connected = true;
    this.handlers?.onConnected();
  }

  /** Posts a message as any author and delivers MESSAGE_CREATE if connected. */
  post(m: { authorId: string; authorIsBot?: boolean; content: string; referenceMessageId?: string | null; channelId?: string; nonce?: string | null; silent?: boolean }): FakeMessage {
    const msg: FakeMessage = {
      id: String(++this.seq),
      channelId: m.channelId ?? this.opts.channelId,
      authorId: m.authorId,
      authorIsBot: m.authorIsBot ?? false,
      content: m.content,
      referenceMessageId: m.referenceMessageId ?? null,
      editedTimestamp: null,
      nonce: m.nonce ?? null,
      silent: m.silent ?? false,
    };
    this.messages.push(msg);
    this.deliver(msg, 'create');
    return msg;
  }

  edit(messageId: string, content: string): void {
    const msg = this.messages.find((m) => m.id === messageId);
    if (!msg) throw new Error('no such message');
    msg.content = content;
    msg.editedTimestamp = new Date().toISOString();
    this.deliver(msg, 'update');
  }

  /** Re-delivers an existing message event (duplicate gateway dispatch). */
  redeliver(messageId: string, type: 'create' | 'update' = 'create'): void {
    const msg = this.messages.find((m) => m.id === messageId);
    if (msg) this.deliver(msg, type);
  }

  postsBy(authorId: string): FakeMessage[] {
    return this.messages.filter((m) => m.authorId === authorId);
  }

  // ---- internals ------------------------------------------------------------

  private deliver(msg: FakeMessage, type: 'create' | 'update'): void {
    if (this.connected && this.handlers) this.handlers.onMessage(this.toIncoming(msg, type));
  }

  private toIncoming(m: FakeMessage, type: 'create' | 'update'): IncomingMessage {
    // Without the Message Content Intent Discord delivers other users' messages with empty content.
    const hidden = !this.opts.messageContentIntent && m.authorId !== this.opts.relayBotId;
    return {
      type,
      id: m.id,
      channelId: m.channelId,
      guildId: this.opts.guildId,
      authorId: m.authorId,
      authorIsBot: m.authorIsBot,
      content: hidden ? '' : m.content,
      referenceMessageId: m.referenceMessageId,
      editedTimestamp: m.editedTimestamp,
      hasAttachmentsOrEmbeds: false,
    };
  }

  private maybeChrisReply(req: FakeMessage): void {
    const chris = this.opts.chris;
    if (!chris || chris.mode === 'silent') return;
    if (!req.content.includes(`<@${this.opts.chrisBotId}>`)) return;
    const id = UUID.exec(req.content)?.[0];
    const text = chris.mode === 'none' ? '[MOCK Chris] 연결 확인' : `요청 ID: ${id}\n[MOCK Chris] 연결 확인`;
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.post({
        authorId: this.opts.chrisBotId,
        authorIsBot: true,
        content: text,
        referenceMessageId: chris.mode === 'reference' ? req.id : null,
      });
    }, chris.delayMs ?? 0);
    this.timers.add(t);
  }
}
