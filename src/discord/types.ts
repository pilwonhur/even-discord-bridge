// Adapter boundary between the relay core and Discord. The core never imports a
// Discord library; the real and fake adapters implement this interface.

export interface IncomingMessage {
  type: 'create' | 'update';
  id: string;
  channelId: string;
  guildId: string | null;
  authorId: string;
  authorIsBot: boolean;
  /** Empty string when Discord withheld content (e.g. Message Content Intent missing). */
  content: string;
  referenceMessageId: string | null;
  editedTimestamp: string | null;
  hasAttachmentsOrEmbeds: boolean;
}

export interface SendParams {
  channelId: string;
  content: string;
  /** The only user ID that may be pinged. everyone/roles are always disabled. */
  mentionUserId: string;
  /** Discord nonce (<= 25 chars), sent with enforce_nonce for short-window dedup. */
  nonce: string;
  /** Post with Discord's SUPPRESS_NOTIFICATIONS flag (no push/desktop alert; still a normal
   *  MESSAGE_CREATE for bots). Used for voice posts so only Chris's reply alerts the phone/G2. */
  silent?: boolean;
}

/**
 * Send failure classes:
 *  - not_sent: the request certainly did not create a message (connection refused, 4xx rejection)
 *  - rate_limited: Discord returned 429; the message was not created; retry after retryAfterMs
 *  - unknown: the message may or may not exist (timeout, reset after write, 5xx)
 */
export type SendErrorKind = 'not_sent' | 'rate_limited' | 'unknown';

export class SendError extends Error {
  kind: SendErrorKind;
  code: string;
  retryAfterMs: number;
  constructor(kind: SendErrorKind, code: string, retryAfterMs = 0) {
    super(`${kind}:${code}`);
    this.kind = kind;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface Readiness {
  ready: boolean;
  problems: string[];
}

export interface AdapterHandlers {
  onMessage(m: IncomingMessage): void;
  /** Called after the gateway (re)connects so the core can run bounded catch-up. */
  onConnected(): void;
  onDisconnected(reason: string): void;
}

export interface DiscordAdapter {
  start(h: AdapterHandlers): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;
  /** Startup checks. Must not post anything. */
  checkReadiness(): Promise<Readiness>;
  send(p: SendParams): Promise<{ messageId: string }>;
  /** Bounded history fetch (oldest first). Used for catch-up and own-post recovery. */
  fetchMessages(channelId: string, opts: { afterId?: string; limit: number }): Promise<IncomingMessage[]>;
}
