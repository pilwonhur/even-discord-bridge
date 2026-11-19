// Relay client (docs/p1/P1-design.md §4). The device token comes from pairing and lives in Even app
// storage; nothing secret is bundled.

export const RELAY = import.meta.env.VITE_RELAY_ORIGIN as string; // app/.env.local (untracked); vite.config.ts refuses to run without it

export class RelayError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** UUID v4 without crypto.randomUUID (not available on the http:// dev origin, which is not a secure context). */
export function uuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function call<T>(path: string, o: { method?: string; token?: string; json?: unknown; body?: Uint8Array<ArrayBuffer>; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  let body: string | Uint8Array<ArrayBuffer> | undefined;
  if (o.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(o.json);
  } else if (o.body) {
    headers['content-type'] = 'application/octet-stream';
    body = o.body;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await fetch(`${RELAY}${path}`, { method: o.method ?? 'POST', headers, body, cache: 'no-store', signal: ctl.signal });
  } catch (e) {
    throw new RelayError(0, (e as Error).name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error_code?: string };
  if (res.status >= 400) throw new RelayError(res.status, data.error_code ?? `http_${res.status}`);
  return { status: res.status, data };
}

export interface PairingStart {
  pairing_id: string;
  code: string;
  claim_secret: string;
  expires_at: string;
}
export interface Transcript {
  transcript_id: string | null;
  text: string;
  no_speech: boolean;
  audio_ms: number;
  stt_ms: number;
  max_rms: number;
}
export interface AskView {
  request_id: string;
  status: string;
  done: boolean;
  reply_available: boolean;
  reply: string;
  late_reply: boolean;
  error_code: string | null;
}

export const api = {
  pairingStart: () => call<PairingStart>('/v1/pairing/start'),
  pairingClaim: (pairing_id: string, claim_secret: string) =>
    call<{ status: 'pending' | 'approved'; device_id?: string; device_token?: string }>('/v1/pairing/claim', { json: { pairing_id, claim_secret } }),
  transcribe: (token: string, pcm: Uint8Array<ArrayBuffer>) => call<Transcript>('/v1/transcriptions', { token, body: pcm, timeoutMs: 90_000 }),
  ask: (token: string, transcriptId: string, key: string) =>
    call<AskView>('/v1/ask', { token, json: { transcript_id: transcriptId, wait_seconds: 25 }, headers: { 'idempotency-key': key }, timeoutMs: 40_000 }),
  displayed: (token: string, id: string, sinceSpeechEndMs?: number) =>
    call<{ recorded: boolean }>(`/v1/ask/${id}/displayed`, { token, json: { page: 1, ...(sinceSpeechEndMs !== undefined ? { since_speech_end_ms: sinceSpeechEndMs } : {}) } }),
  askGet: (token: string, id: string, wait = 25) => call<AskView>(`/v1/ask/${id}?wait=${wait}`, { method: 'GET', token, timeoutMs: (wait + 15) * 1000 }),
};
