// HTTP API (02_TECHNICAL_DESIGN §3). New relay API — not an OpenClaw API.
//   POST /v1/requests        {"target":"chris-primary","template":"...","arguments":{}}
//   GET  /v1/requests/{id}
//   GET  /healthz            (no auth; readiness booleans only)
// P1 voice (free_text scope only; docs/p1/siri-shortcut.md):
//   POST /v1/ask             {"text":"…","wait_seconds":25}   Idempotency-Key optional
//   GET  /v1/ask/{id}?wait=25
// P1 G2 app (docs/p1/P1-design.md §4; tailnet identity required, no bearer for pairing):
//   POST /v1/pairing/start                          → {pairing_id, code, claim_secret, expires_at}
//   POST /v1/pairing/claim {pairing_id, claim_secret} → 202 pending | 200 {device_id, device_token} once
//   POST /v1/transcriptions  (device token) application/octet-stream PCM s16le 16 kHz mono ≤ 30 s
//   POST /v1/ask {"transcript_id":"…"}  (device token: server-side transcript only, never client text)
//   POST /v1/ask/{id}/displayed {page:1, since_speech_end_ms?}  (device token: reply reached the lens; first call only)
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage as HttpReq, Server, ServerResponse } from 'node:http';
import type { Pairing } from '../devices.ts';
import type { Logger } from '../log.ts';
import type { RelayService } from '../service.ts';
import { isTemplateName } from '../templates.ts';
import { MAX_PCM_BYTES, MIN_PCM_BYTES, pcmStats } from '../stt.ts';
import type { Transcriber } from '../stt.ts';
import type { Store } from '../store/store.ts';
import { errorMessage, normalizeVoiceText } from '../voice.ts';
import type { Authenticator, RateLimiter } from './auth.ts';

export interface ApiDeps {
  service: RelayService;
  auth: Authenticator;
  limiter: RateLimiter;
  logger: Logger;
  targetAlias: string;
  allowedOrigins: string[];
  tailscaleLogins: string[];
  /** P1 G2 app. Absent → pairing/transcription routes answer 404/503. */
  pairing?: Pairing;
  pairingLimiter?: RateLimiter;
  transcriber?: Transcriber;
  store?: Store;
  sttMinRms?: number;
  now?: () => number;
  newId?: () => string;
}

/** A transcript can be sent to Chris for this long after it was recognised. */
export const TRANSCRIPT_TTL_MS = 10 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_FIELDS = new Set(['target', 'template', 'arguments']);
const ASK_FIELDS = new Set(['target', 'text', 'transcript_id', 'wait_seconds']);
const CLAIM_FIELDS = new Set(['pairing_id', 'claim_secret']);
const DEFAULT_WAIT_S = 25;
const MAX_WAIT_S = 55;

function waitSeconds(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_WAIT_S;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > MAX_WAIT_S) throw new HttpError(400, 'invalid_wait', `wait must be 0..${MAX_WAIT_S}`);
  return n;
}
const MAX_BODY = 4096;

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(data);
}

async function readPcm(req: HttpReq): Promise<Buffer> {
  const ct = req.headers['content-type'] ?? '';
  if (!ct.toLowerCase().startsWith('application/octet-stream')) throw new HttpError(415, 'unsupported_media_type');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_PCM_BYTES) throw new HttpError(413, 'audio_too_long');
    chunks.push(c as Buffer);
  }
  const pcm = Buffer.concat(chunks);
  if (pcm.length % 2 !== 0) throw new HttpError(400, 'audio_invalid');
  if (pcm.length < MIN_PCM_BYTES) throw new HttpError(400, 'audio_too_short');
  return pcm;
}

async function readJson(req: HttpReq): Promise<unknown> {
  const ct = req.headers['content-type'] ?? '';
  if (!ct.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body_too_large');
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

/** Wildcard port for the installed Even app: its WebView origin is http://127.0.0.1:<port>, port changes per launch. */
export const LOOPBACK_ANY_PORT = 'http://127.0.0.1:*';

/** Exact origin match, plus LOOPBACK_ANY_PORT (loopback host only; no other wildcard is accepted by config). */
export function originAllowed(allowed: string[], origin: string): boolean {
  if (allowed.includes(origin)) return true;
  return allowed.includes(LOOPBACK_ANY_PORT) && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin);
}

export function createApiServer(d: ApiDeps): Server {
  const now = d.now ?? Date.now;
  const newId = d.newId ?? randomUUID;
  let sttBusy = false;
  const cors = (req: HttpReq): Record<string, string> => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !originAllowed(d.allowedOrigins, origin)) return {};
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'authorization, content-type, idempotency-key',
      'access-control-max-age': '600',
      'access-control-allow-methods': 'GET, POST',
      vary: 'Origin',
    };
  };

  return createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://relay.local');
    let status = 500;
    // CORS headers on every response, including errors, so the Even WebView can read error codes.
    const extra = cors(req);
    try {
      if (req.method === 'OPTIONS') {
        status = extra['access-control-allow-origin'] ? 204 : 403;
        res.writeHead(status, extra);
        res.end();
        return;
      }
      if (req.method === 'GET' && url.pathname === '/healthz') {
        const r = d.service.readiness();
        status = 200;
        // Readiness booleans only, so any origin may read it (P1 spike S2: Even WebView reachability).
        return send(res, 200, { ready: r.ready, connected: r.connected }, { ...extra, 'access-control-allow-origin': extra['access-control-allow-origin'] ?? '*' });
      }

      // Second factor when exposed via Tailscale Serve: Serve sets this header for tailnet users and
      // strips client-supplied copies. The relay binds loopback only, so it cannot arrive any other way
      // except from a local process on this Mac.
      const requireTailnet = () => {
        if (!d.tailscaleLogins.length) return;
        const login = req.headers['tailscale-user-login'];
        if (typeof login !== 'string' || !d.tailscaleLogins.includes(login)) throw new HttpError(403, 'tailnet_identity_required');
      };

      // ---- P1-02 pairing: no bearer yet, so the tailnet identity is the gate (plus operator approval).
      if (req.method === 'POST' && (url.pathname === '/v1/pairing/start' || url.pathname === '/v1/pairing/claim')) {
        if (!d.pairing) throw new HttpError(404, 'not_found');
        requireTailnet();
        if (d.pairingLimiter && !d.pairingLimiter.allow('pairing')) throw new HttpError(429, 'rate_limited');
        if (url.pathname === '/v1/pairing/start') {
          const r = d.pairing.start();
          if (!r.ok) throw new HttpError(429, r.code);
          d.logger.info('pairing_started', { pairing_id: r.pairingId });
          status = 201;
          return send(res, 201, { pairing_id: r.pairingId, code: r.code, claim_secret: r.claimSecret, expires_at: new Date(r.expiresAt).toISOString() }, extra);
        }
        const body = await readJson(req);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'invalid_request');
        if (Object.keys(body).some((k) => !CLAIM_FIELDS.has(k))) throw new HttpError(400, 'unsupported_field');
        const b = body as { pairing_id?: unknown; claim_secret?: unknown };
        const r = d.pairing.claim(b.pairing_id, b.claim_secret);
        if (!r.ok) throw new HttpError(r.code === 'not_found' ? 404 : r.code === 'pairing_expired' ? 410 : 409, r.code);
        if (r.status === 'pending') {
          status = 202;
          return send(res, 202, { status: 'pending', expires_at: new Date(r.expiresAt).toISOString() }, extra);
        }
        d.logger.info('device_paired', { device_id: r.deviceId });
        status = 200;
        return send(res, 200, { status: 'approved', device_id: r.deviceId, device_token: r.deviceToken }, extra);
      }

      const auth = d.auth.authenticate(req.headers.authorization);
      if (!auth.ok) throw new HttpError(auth.status, auth.code);
      requireTailnet();
      const isDevice = auth.scopes.includes('device');

      // ---- P1-03 speech to text on this Mac. Audio is held in memory only for this call.
      if (req.method === 'POST' && url.pathname === '/v1/transcriptions') {
        if (!isDevice && !auth.scopes.includes('free_text')) throw new HttpError(403, 'scope_not_allowed');
        if (!d.transcriber || !d.store || !d.transcriber.available()) throw new HttpError(503, 'stt_unavailable');
        if (!d.limiter.allow(auth.principalId)) throw new HttpError(429, 'rate_limited');
        const pcm = await readPcm(req);
        const stats = pcmStats(pcm);
        const base = { audio_ms: stats.audioMs, max_rms: stats.maxFrameRms, model: d.transcriber.model };
        if (stats.maxFrameRms < (d.sttMinRms ?? 0)) {
          d.logger.info('stt', { ...base, no_speech: true, gated: true, device_id: auth.deviceId ?? null });
          status = 200;
          return send(res, 200, { transcript_id: null, text: '', no_speech: true, stt_ms: 0, ...base }, extra);
        }
        if (sttBusy) throw new HttpError(409, 'stt_busy');
        sttBusy = true;
        const t0 = Date.now();
        let text: string;
        try {
          text = await d.transcriber.transcribe(pcm);
        } catch (e) {
          d.logger.error('stt_failed', { error: String((e as Error).message).slice(0, 80) });
          throw new HttpError(502, 'stt_failed');
        } finally {
          sttBusy = false;
        }
        const sttMs = Date.now() - t0;
        const id = text ? newId() : null;
        if (id) d.store.insertTranscript({ id, principal_id: auth.principalId, text, audio_ms: stats.audioMs, stt_ms: sttMs, model: d.transcriber.model, created_at: now() });
        // Never log the recognised text (P0 logging rule).
        d.logger.info('stt', { ...base, no_speech: !text, stt_ms: sttMs, chars: [...text].length, device_id: auth.deviceId ?? null });
        status = 200;
        return send(res, 200, { transcript_id: id, text, no_speech: !text, stt_ms: sttMs, ...base }, extra);
      }

      if (req.method === 'POST' && url.pathname === '/v1/ask') {
        if (!auth.scopes.includes('free_text') && !isDevice) throw new HttpError(403, 'scope_not_allowed');
        if (!d.limiter.allow(auth.principalId)) throw new HttpError(429, 'rate_limited');
        const keyHdr = req.headers['idempotency-key'];
        if (keyHdr !== undefined && (typeof keyHdr !== 'string' || !UUID.test(keyHdr))) throw new HttpError(400, 'idempotency_key_invalid', 'Idempotency-Key must be a UUID if present');
        const body = await readJson(req);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'invalid_request');
        const extraFields = Object.keys(body).filter((k) => !ASK_FIELDS.has(k));
        if (extraFields.length) throw new HttpError(400, 'unsupported_field', `unsupported fields: ${extraFields.join(', ')}`);
        const b = body as { target?: unknown; text?: unknown; transcript_id?: unknown; wait_seconds?: unknown };
        if (b.target !== undefined && b.target !== d.targetAlias) throw new HttpError(403, 'target_not_allowed');
        const wait = waitSeconds(b.wait_seconds);
        let raw: unknown = b.text;
        if (isDevice) {
          // The G2 app may only send what this Mac recognised: voice → transcript → Discord is one traceable line.
          if (b.text !== undefined) throw new HttpError(400, 'text_not_allowed_for_device');
          const tr = typeof b.transcript_id === 'string' && UUID.test(b.transcript_id) ? d.store?.transcript(b.transcript_id.toLowerCase()) : undefined;
          if (!tr || tr.principal_id !== auth.principalId || tr.text === null) throw new HttpError(404, 'transcript_not_found');
          if (now() - tr.created_at > TRANSCRIPT_TTL_MS) throw new HttpError(410, 'transcript_expired');
          raw = tr.text;
        } else if (b.transcript_id !== undefined) {
          throw new HttpError(400, 'unsupported_field', 'unsupported fields: transcript_id');
        }
        const t = normalizeVoiceText(raw);
        if (!t.ok) throw new HttpError(400, t.code);
        const r = d.service.submitText(auth.principalId, typeof keyHdr === 'string' ? keyHdr.toLowerCase() : null, d.targetAlias, t.text);
        if (r.kind === 'busy') throw new HttpError(409, 'channel_busy');
        if (r.kind === 'not_ready') throw new HttpError(503, 'relay_not_ready');
        if (r.kind === 'idempotency_conflict') throw new HttpError(409, 'idempotency_conflict');
        await d.service.waitWhileInFlight(r.request.id, wait * 1000, () => res.destroyed);
        status = r.kind === 'created' ? 201 : 200;
        return send(res, status, { ...d.service.askView(auth.principalId, r.request.id), replayed: r.kind === 'replayed' }, extra);
      }

      const ask = /^\/v1\/ask\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && ask) {
        if (!auth.scopes.includes('free_text') && !isDevice) throw new HttpError(403, 'scope_not_allowed');
        const id = ask[1]!.toLowerCase();
        if (!UUID.test(id) || !d.service.askView(auth.principalId, id)) throw new HttpError(404, 'not_found');
        await d.service.waitWhileInFlight(id, waitSeconds(url.searchParams.get('wait')) * 1000, () => res.destroyed);
        status = 200;
        return send(res, 200, d.service.askView(auth.principalId, id), extra);
      }

      // ---- P1-04 the app drew the first reply page on the lens (AT-23 latency: t5, and t5 − t0 on the phone clock).
      const shown = /^\/v1\/ask\/([^/]+)\/displayed$/.exec(url.pathname);
      if (req.method === 'POST' && shown) {
        if (!isDevice) throw new HttpError(403, 'scope_not_allowed');
        const id = shown[1]!.toLowerCase();
        const view = UUID.test(id) ? d.service.askView(auth.principalId, id) : undefined;
        if (!view) throw new HttpError(404, 'not_found');
        if (!view.reply_available) throw new HttpError(409, 'reply_not_available');
        const b = (await readJson(req)) as Record<string, unknown> | null;
        const page = b?.page ?? 1;
        const since = b?.since_speech_end_ms;
        if (!Number.isInteger(page) || (page as number) < 1 || (page as number) > 1000) throw new HttpError(400, 'invalid_page');
        if (since !== undefined && (!Number.isInteger(since) || (since as number) < 0 || (since as number) > 3_600_000)) throw new HttpError(400, 'invalid_since_speech_end_ms');
        if (!d.store) throw new HttpError(503, 'store_unavailable');
        status = 200;
        if (d.store.events(id).some((e) => e.event === 'displayed')) return send(res, 200, { recorded: false }, extra);
        const at = now();
        const row = d.store.get(id);
        const fields = {
          page: page as number,
          ...(since !== undefined ? { since_speech_end_ms: since as number } : {}),
          ...(row?.first_reply_at ? { reply_to_display_ms: at - row.first_reply_at } : {}),
        };
        d.store.event(id, at, 'displayed', JSON.stringify(fields));
        d.logger.info('displayed', { request_id: id, ...fields, ...(auth.deviceId ? { device_id: auth.deviceId } : {}) });
        return send(res, 200, { recorded: true }, extra);
      }

      if (req.method === 'POST' && url.pathname === '/v1/requests') {
        if (!auth.scopes.includes('template')) throw new HttpError(403, 'scope_not_allowed');
        if (!d.limiter.allow(auth.principalId)) throw new HttpError(429, 'rate_limited');
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || !UUID.test(key)) throw new HttpError(400, 'idempotency_key_required', 'Idempotency-Key must be a UUID');
        const body = await readJson(req);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'invalid_request');
        const extraFields = Object.keys(body).filter((k) => !ALLOWED_FIELDS.has(k));
        // Raw channel_id / agent_id / free text / mentions / user_id are refused (AT-01, AT-02).
        if (extraFields.length) throw new HttpError(400, 'unsupported_field', `unsupported fields: ${extraFields.join(', ')}`);
        const b = body as { target?: unknown; template?: unknown; arguments?: unknown };
        if (b.target !== d.targetAlias) throw new HttpError(403, 'target_not_allowed');
        if (!isTemplateName(b.template)) throw new HttpError(400, 'template_not_allowed');
        if (b.arguments !== undefined && (typeof b.arguments !== 'object' || b.arguments === null || Array.isArray(b.arguments) || Object.keys(b.arguments).length > 0)) {
          throw new HttpError(400, 'arguments_not_allowed');
        }
        const r = d.service.submit(auth.principalId, key.toLowerCase(), b.target, b.template);
        switch (r.kind) {
          case 'created':
            status = 202;
            return send(res, 202, { request_id: r.request.id, status: r.request.status, target: r.request.target }, extra);
          case 'replayed':
            status = 200;
            return send(res, 200, { request_id: r.request.id, status: d.service.view(auth.principalId, r.request.id)?.status, target: r.request.target, replayed: true }, extra);
          case 'idempotency_conflict':
            throw new HttpError(409, 'idempotency_conflict');
          case 'busy':
            throw new HttpError(409, 'channel_busy');
          case 'not_ready':
            throw new HttpError(503, 'relay_not_ready');
        }
      }

      const m = /^\/v1\/requests\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && m) {
        const v = UUID.test(m[1]!) ? d.service.view(auth.principalId, m[1]!.toLowerCase()) : undefined;
        if (!v) throw new HttpError(404, 'not_found');
        status = 200;
        return send(res, 200, v, extra);
      }
      throw new HttpError(404, 'not_found');
    } catch (e) {
      if (e instanceof HttpError) {
        status = e.status;
        // Voice clients (Siri Shortcut) just show/speak `reply`, so errors carry a Korean line too.
        const voice = url.pathname === '/v1/ask' || url.pathname.startsWith('/v1/ask/');
        send(res, e.status, { error_code: e.code, message: e.message, ...(voice ? { done: true, reply_available: false, reply: errorMessage(e.code) } : {}) }, extra);
      } else {
        status = 500;
        d.logger.error('api_internal_error', { error: String(e) });
        send(res, 500, { error_code: 'internal_error' }, extra);
      }
    } finally {
      // origin / ts_login: P1 spike S2 (what the Even WebView sends, whether Serve attached an identity).
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin.replace(/[^\x20-\x7e]/g, '?').slice(0, 120) : null;
      d.logger.info('http', {
        method: req.method,
        path: url.pathname.replace(/[0-9a-f-]{36}/i, ':id'),
        status,
        ms: Date.now() - started,
        ...(origin !== null ? { origin } : {}),
        ts_login: typeof req.headers['tailscale-user-login'] === 'string',
      });
    }
  });
}
