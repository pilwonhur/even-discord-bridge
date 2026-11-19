// P1 voice text (docs/p1/P1-design.md §9 D1, §11). The client (Siri Shortcut, later Even AI)
// has already transcribed speech; the relay only accepts a bounded, single-line sentence,
// neutralises Discord markup, and posts it under a header that marks it as a relayed,
// conversation-only request (posted silently: the phone/G2 is alerted only by Chris's reply,
// whose first line is the answer and last line the request ID). The owner's policy decision D1: anything that needs real
// action is confirmed in Discord first — stated in the post, enforced by Chris's own policy.

export const MAX_VOICE_CHARS = 500;
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// C0/C1 controls, zero-width and bidi override characters.
const INVISIBLE_RANGES: [number, number][] = [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff]];
const cp = (n: number) => '\\u' + n.toString(16).padStart(4, '0');
const INVISIBLE = new RegExp('[' + INVISIBLE_RANGES.map(([a, b]) => `${cp(a)}-${cp(b)}`).join('') + ']', 'g');

export type TextCheck = { ok: true; text: string } | { ok: false; code: 'text_required' | 'text_empty' | 'text_too_long' | 'text_not_allowed' };

export function normalizeVoiceText(raw: unknown): TextCheck {
  if (typeof raw !== 'string') return { ok: false, code: 'text_required' };
  // One line only: a multi-line input could imitate the relay header ("요청 ID: …").
  let t = raw.normalize('NFC').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return { ok: false, code: 'text_empty' };
  if ([...t].length > MAX_VOICE_CHARS) return { ok: false, code: 'text_too_long' };
  // A UUID in the sentence could be echoed by Chris and confuse request-ID correlation.
  if (UUID_ANY.test(t)) return { ok: false, code: 'text_not_allowed' };
  // No user/role/channel mentions, @everyone/@here or other <…> markup can survive.
  // (allowed_mentions already blocks pings; this also keeps the raw text inert for other bots.)
  t = t.replace(/</g, '‹').replace(/>/g, '›').replace(/@/g, '＠');
  return { ok: true, text: t };
}

export function renderVoiceRequest(o: { requestId: string; principalId: string; chrisBotId: string; text: string; ownerTitle?: string }): string {
  return [
    '[G2 음성 중계 · 인증된 사용자 요청 · 대화 전용]',
    `요청 ID: ${o.requestId}`,
    `인증 주체: ${o.principalId} (작성자는 중계 봇 · 음성 인식 문장이라 오인식이 있을 수 있음)`,
    `<@${o.chrisBotId}> ${o.text}`,
    `답은 한 메시지로, 안경 화면에 맞게 마크다운 없이 300자 이내 한국어 문장으로 시작하고, 위 요청 ID는 답변 맨 마지막 줄에 그대로 적어 주세요. 실행·발송·설정 변경이 필요한 일이면 실행하지 말고, Discord에서 ${o.ownerTitle ?? '사용자'} 확인을 받겠다고만 답해 주세요.`,
  ].join('\n');
}

/** Display text for glasses/Siri: drop the echoed request ID line and markdown decoration. */
export function cleanReply(text: string, requestId: string): string {
  const id = requestId.replace(/[^0-9a-f-]/gi, '');
  const idRe = new RegExp(id, 'ig');
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    let line = raw;
    if (line.toLowerCase().includes(id.toLowerCase())) {
      line = line.replace(idRe, '').replace(/요청\s*ID\s*[:：]?/gi, '');
      // Nothing left but punctuation/markup → it was only the ID line.
      if (!/[\p{L}\p{N}]/u.test(line)) continue;
    }
    lines.push(
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/\*\*|__|`/g, '')
        .trim(),
    );
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Korean status line for clients that just show/speak `reply` (Siri Shortcut). */
export function statusMessage(status: string, errorCode: string | null): string {
  switch (status) {
    case 'accepted':
    case 'sending':
    case 'awaiting_reply':
      return '아직 Chris 답을 기다리는 중입니다. 잠시 후 다시 확인해 주세요.';
    case 'delivery_unknown':
      return '전송됐는지 확인하지 못했습니다. Discord에서 확인해 주세요.';
    case 'timed_out':
      return 'Chris가 제한 시간 안에 답하지 않았습니다. 나중에 다시 확인해 주세요.';
    case 'ambiguous_response':
      return '답을 이 질문과 확실히 연결하지 못했습니다. Discord에서 확인해 주세요.';
    case 'failed':
      return `전송에 실패했습니다 (${errorCode ?? 'unknown'}).`;
    default:
      return '';
  }
}

export function errorMessage(code: string): string {
  const m: Record<string, string> = {
    unauthenticated: '인증에 실패했습니다. 단축어의 토큰을 확인해 주세요.',
    principal_disabled: '이 기기의 접근이 꺼져 있습니다.',
    scope_not_allowed: '이 토큰으로는 이 기능을 쓸 수 없습니다.',
    tailnet_identity_required: 'Tailscale 연결을 확인해 주세요.',
    rate_limited: '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.',
    channel_busy: '이전 질문의 답을 기다리는 중입니다. 잠시 후 다시 시도해 주세요.',
    relay_not_ready: '중계 서비스가 Discord에 연결되어 있지 않습니다.',
    text_required: '보낼 문장이 없습니다.',
    text_empty: '말씀을 인식하지 못했습니다.',
    text_too_long: `문장이 너무 깁니다 (${MAX_VOICE_CHARS}자 이내).`,
    text_not_allowed: '보낼 수 없는 문장입니다.',
    not_found: '요청을 찾을 수 없습니다.',
    device_revoked: '이 기기의 등록이 취소되었습니다. 다시 등록해 주세요.',
    transcript_not_found: '인식된 문장을 찾을 수 없습니다. 다시 말해 주세요.',
    transcript_expired: '인식한 지 오래되었습니다. 다시 말해 주세요.',
    text_not_allowed_for_device: '이 기기는 음성 인식 문장만 보낼 수 있습니다.',
  };
  return m[code] ?? `요청을 처리하지 못했습니다 (${code}).`;
}
