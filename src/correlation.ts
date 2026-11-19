// Response correlation (FR-05, AT-11). Pure function: decides whether an incoming
// Discord message is the reply to a specific relay request. "Next message after the
// request" is never used; author display names and timing are never used.
import type { IncomingMessage } from './discord/types.ts';

export interface CorrelationContext {
  guildId: string;
  channelId: string;
  chrisBotId: string;
  relayBotId: string;
  /** Request whose posted Discord message has this ID (same target channel only). */
  requestByDiscordMessage(messageId: string): { id: string } | undefined;
  /** Request with this request_id posted to this channel. */
  requestById(id: string): { id: string } | undefined;
}

export type Correlation =
  | { kind: 'ignore'; reason: 'other_channel' | 'self_author' | 'non_target_author' }
  | { kind: 'match'; requestId: string; basis: 'reference' | 'reference+request_id' | 'request_id_text' }
  | { kind: 'ambiguous'; reason: 'reference_request_id_conflict' | 'multiple_request_ids' | 'unreferenced'; requestIds: string[] };

const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function correlate(m: IncomingMessage, ctx: CorrelationContext): Correlation {
  if (m.channelId !== ctx.channelId || (m.guildId !== null && m.guildId !== ctx.guildId)) return { kind: 'ignore', reason: 'other_channel' };
  // Loop prevention (FR-09): the relay's own posts are never treated as input.
  if (m.authorId === ctx.relayBotId) return { kind: 'ignore', reason: 'self_author' };
  // Only the actual Chris bot ID counts, regardless of display name.
  if (m.authorId !== ctx.chrisBotId) return { kind: 'ignore', reason: 'non_target_author' };

  const refReq = m.referenceMessageId ? ctx.requestByDiscordMessage(m.referenceMessageId) : undefined;
  const textIds = new Set<string>();
  for (const raw of m.content.match(UUID_G) ?? []) {
    const r = ctx.requestById(raw.toLowerCase());
    if (r) textIds.add(r.id);
  }

  if (refReq) {
    if (textIds.size === 0) return { kind: 'match', requestId: refReq.id, basis: 'reference' };
    if (textIds.size === 1 && textIds.has(refReq.id)) return { kind: 'match', requestId: refReq.id, basis: 'reference+request_id' };
    return { kind: 'ambiguous', reason: 'reference_request_id_conflict', requestIds: [refReq.id, ...textIds] };
  }
  if (textIds.size === 1) return { kind: 'match', requestId: [...textIds][0]!, basis: 'request_id_text' };
  if (textIds.size > 1) return { kind: 'ambiguous', reason: 'multiple_request_ids', requestIds: [...textIds] };
  return { kind: 'ambiguous', reason: 'unreferenced', requestIds: [] };
}
