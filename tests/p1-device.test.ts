// P1-02 device pairing and P1-03 transcription (+ /v1/ask with a server transcript).
// MOCK ONLY: FakeDiscord, FakeTranscriber. Not evidence of G2/Even/whisper accuracy.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { PAIRING_TTL_MS } from '../src/devices.ts';
import { TRANSCRIPT_TTL_MS } from '../src/api/server.ts';
import { cleanTranscript, FakeTranscriber, MAX_PCM_BYTES, pcmStats, WhisperCli } from '../src/stt.ts';
import { TOKEN, VOICE_TOKEN, harness } from './helpers.ts';
import type { Harness } from './helpers.ts';

/** s16le 16 kHz mono sine (amplitude 0 = silence). */
function pcm(ms: number, amplitude: number): Buffer {
  const n = (16000 * ms) / 1000;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / 16000)), i * 2);
  return b;
}

async function call(h: Harness, path: string, init: { method?: string; token?: string | null; json?: unknown; body?: Buffer; ct?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  let body: string | Uint8Array<ArrayBuffer> | undefined;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.body) {
    headers['content-type'] = init.ct ?? 'application/octet-stream';
    body = new Uint8Array(init.body);
  }
  const res = await fetch(`${h.base}${path}`, { method: init.method ?? 'POST', headers, body });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

/** start → operator approves → claim. Returns the device token. */
async function pair(h: Harness): Promise<{ token: string; deviceId: string }> {
  const s = await call(h, '/v1/pairing/start');
  assert.equal(s.status, 201);
  assert.match(s.json.code, /^\d{6}$/);
  const pending = await call(h, '/v1/pairing/claim', { json: { pairing_id: s.json.pairing_id, claim_secret: s.json.claim_secret } });
  assert.equal(pending.status, 202);
  assert.ok(h.app.store.approvePairing(s.json.code, h.clock.t));
  const c = await call(h, '/v1/pairing/claim', { json: { pairing_id: s.json.pairing_id, claim_secret: s.json.claim_secret } });
  assert.equal(c.status, 200);
  assert.match(c.json.device_token, /^g2d_/);
  return { token: c.json.device_token, deviceId: c.json.device_id };
}

describe('P1-02 device pairing (mock)', () => {
  it('start → approve → claim once; only hashes stored; token works; revoke is immediate', async () => {
    const h = await harness();
    try {
      const s = await call(h, '/v1/pairing/start');
      const claim = { pairing_id: s.json.pairing_id, claim_secret: s.json.claim_secret };
      assert.equal((await call(h, '/v1/pairing/claim', { json: { ...claim, claim_secret: 'wrong' } })).status, 404);
      assert.equal(h.app.store.approvePairing('000000' === s.json.code ? '111111' : '000000', h.clock.t), undefined);
      assert.ok(h.app.store.approvePairing(s.json.code, h.clock.t));
      assert.equal(h.app.store.approvePairing(s.json.code, h.clock.t), undefined, 'approval is single use');
      const c = await call(h, '/v1/pairing/claim', { json: claim });
      assert.equal(c.status, 200);
      const again = await call(h, '/v1/pairing/claim', { json: claim });
      assert.equal(again.status, 409);
      assert.equal(again.json.error_code, 'already_claimed');

      const dump = JSON.stringify(h.app.store.db.prepare('SELECT * FROM devices').all()) + JSON.stringify(h.app.store.db.prepare('SELECT * FROM pairings').all());
      assert.ok(!dump.includes(c.json.device_token) && !dump.includes(s.json.claim_secret), 'no plaintext secrets in the DB');
      assert.ok(!h.logs.join('\n').includes(c.json.device_token) && !h.logs.join('\n').includes(s.json.claim_secret), 'no secrets in logs');

      const ok = await call(h, '/v1/transcriptions', { token: c.json.device_token, body: pcm(1000, 3000) });
      assert.equal(ok.status, 200);
      // The device token cannot do P0 templates.
      const tpl = await fetch(`${h.base}/v1/requests`, {
        method: 'POST',
        headers: { authorization: `Bearer ${c.json.device_token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: JSON.stringify({ target: 'chris-primary', template: 'connection_check', arguments: {} }),
      });
      assert.equal(tpl.status, 403);

      assert.ok(h.app.store.revokeDevice(c.json.device_id, h.clock.t));
      const revoked = await call(h, '/v1/transcriptions', { token: c.json.device_token, body: pcm(1000, 3000) });
      assert.equal(revoked.status, 403);
      assert.equal(revoked.json.error_code, 'device_revoked');
      // Other credentials are untouched by a device revocation.
      assert.equal((await call(h, '/v1/transcriptions', { token: VOICE_TOKEN, body: pcm(1000, 3000) })).status, 200);
    } finally {
      await h.close();
    }
  });

  it('pairing expires after 5 minutes and at most 3 can be pending', async () => {
    const h = await harness();
    try {
      const s = await call(h, '/v1/pairing/start');
      h.advance(PAIRING_TTL_MS + 1);
      assert.equal(h.app.store.approvePairing(s.json.code, h.clock.t), undefined);
      const exp = await call(h, '/v1/pairing/claim', { json: { pairing_id: s.json.pairing_id, claim_secret: s.json.claim_secret } });
      assert.equal(exp.status, 410);
      for (let i = 0; i < 3; i++) assert.equal((await call(h, '/v1/pairing/start')).status, 201);
      const fourth = await call(h, '/v1/pairing/start');
      assert.equal(fourth.status, 429);
      assert.equal(fourth.json.error_code, 'too_many_pairings');
    } finally {
      await h.close();
    }
  });
});

describe('P1-03 transcriptions (mock transcriber)', () => {
  it('quiet audio is no_speech without running whisper; speech returns a stored transcript, not logged', async () => {
    const stt = new FakeTranscriber('세미나 준비 상황 알려줘');
    const h = await harness({ transcriber: stt });
    try {
      const { token } = await pair(h);
      const quiet = await call(h, '/v1/transcriptions', { token, body: pcm(2000, 100) });
      assert.equal(quiet.status, 200);
      assert.equal(quiet.json.no_speech, true);
      assert.equal(quiet.json.transcript_id, null);
      assert.equal(stt.calls, 0);

      const r = await call(h, '/v1/transcriptions', { token, body: pcm(3000, 4000) });
      assert.equal(r.status, 200);
      assert.equal(r.json.text, '세미나 준비 상황 알려줘');
      assert.equal(r.json.audio_ms, 3000);
      assert.equal(r.json.model, 'fake');
      assert.ok(h.app.store.transcript(r.json.transcript_id));
      assert.ok(!h.logs.join('\n').includes('세미나 준비'), 'recognised text never logged');
    } finally {
      await h.close();
    }
  });

  it('refuses wrong type, odd length, too short, too long, and P0 tokens', async () => {
    const h = await harness();
    try {
      const { token } = await pair(h);
      assert.equal((await call(h, '/v1/transcriptions', { token, body: pcm(1000, 3000), ct: 'audio/wav' })).status, 415);
      assert.equal((await call(h, '/v1/transcriptions', { token, body: Buffer.alloc(10_001) })).json.error_code, 'audio_invalid');
      assert.equal((await call(h, '/v1/transcriptions', { token, body: pcm(100, 3000) })).json.error_code, 'audio_too_short');
      assert.equal(MAX_PCM_BYTES, 960_000);
      const big = await call(h, '/v1/transcriptions', { token, body: Buffer.alloc(MAX_PCM_BYTES + 2) }).catch(() => ({ status: 413, json: {} }));
      assert.equal(big.status, 413);
      assert.equal((await call(h, '/v1/transcriptions', { token: TOKEN, body: pcm(1000, 3000) })).status, 403);
      assert.equal((await call(h, '/v1/transcriptions', { body: pcm(1000, 3000) })).status, 401);
    } finally {
      await h.close();
    }
  });

  it('unavailable whisper → 503 stt_unavailable', async () => {
    const h = await harness({ transcriber: new WhisperCli({ bin: '/nonexistent/whisper-cli', modelPath: '/nonexistent/ggml-small.bin' }) });
    try {
      const { token } = await pair(h);
      const r = await call(h, '/v1/transcriptions', { token, body: pcm(1000, 3000) });
      assert.equal(r.status, 503);
      assert.equal(r.json.error_code, 'stt_unavailable');
    } finally {
      await h.close();
    }
  });

  it('helpers: loudest-frame RMS and transcript cleanup', () => {
    assert.equal(pcmStats(pcm(1000, 0)).maxFrameRms, 0);
    const s = pcmStats(Buffer.concat([pcm(900, 0), pcm(100, 2000)]));
    assert.equal(s.audioMs, 1000);
    assert.ok(s.maxFrameRms > 1300 && s.maxFrameRms < 1500, String(s.maxFrameRms)); // 2000/√2
    assert.equal(cleanTranscript(' [음악] 크리스 (박수) 안녕\n'), '크리스 안녕');
    assert.equal(cleanTranscript(' -감사합니다. -감사합니다.'), '감사합니다. 감사합니다.');
  });
});

describe('P1-04 /v1/ask with a server transcript (mock)', () => {
  it('device sends transcript_id only; Discord gets the recognised sentence, silently', async () => {
    const h = await harness({ chris: 'request_id', transcriber: new FakeTranscriber('세미나 준비 상황 <@1> 알려줘') });
    try {
      const { token } = await pair(h);
      const t = await call(h, '/v1/transcriptions', { token, body: pcm(2000, 4000) });
      const text = await call(h, '/v1/ask', { token, json: { text: '임의 문장', wait_seconds: 0 } });
      assert.equal(text.status, 400);
      assert.equal(text.json.error_code, 'text_not_allowed_for_device');
      assert.equal((await call(h, '/v1/ask', { token, json: { transcript_id: randomUUID(), wait_seconds: 0 } })).status, 404);

      const r = await call(h, '/v1/ask', { token, json: { transcript_id: t.json.transcript_id, wait_seconds: 5 } });
      assert.equal(r.status, 201);
      const msg = h.fake.postsBy(h.app.config.relayBotId).at(-1)!;
      assert.match(msg.content, /세미나 준비 상황 ‹＠1› 알려줘/);
      assert.equal(msg.silent, true);
      const g = await call(h, `/v1/ask/${r.json.request_id}?wait=0`, { method: 'GET', token });
      assert.equal(g.status, 200);
      // Another principal (Siri voice token) cannot read the device's request or use its transcript.
      assert.equal((await call(h, `/v1/ask/${r.json.request_id}?wait=0`, { method: 'GET', token: VOICE_TOKEN })).status, 404);
      assert.equal((await call(h, '/v1/ask', { token: VOICE_TOKEN, json: { transcript_id: t.json.transcript_id } })).status, 400);
    } finally {
      await h.close();
    }
  });

  it('a transcript older than 10 minutes cannot be sent', async () => {
    const h = await harness();
    try {
      const { token } = await pair(h);
      const t = await call(h, '/v1/transcriptions', { token, body: pcm(2000, 4000) });
      h.advance(TRANSCRIPT_TTL_MS + 1);
      const r = await call(h, '/v1/ask', { token, json: { transcript_id: t.json.transcript_id, wait_seconds: 0 } });
      assert.equal(r.status, 410);
      assert.equal(r.json.error_code, 'transcript_expired');
    } finally {
      await h.close();
    }
  });
});

describe('P1-04 displayed (mock)', () => {
  it('records the first lens display once, with phone-clock speech-end latency; owner device only', async () => {
    const h = await harness({ chris: 'request_id', transcriber: new FakeTranscriber('내일 일정 알려줘') });
    try {
      const { token, deviceId } = await pair(h);
      const t = await call(h, '/v1/transcriptions', { token, body: pcm(2000, 4000) });
      const r = await call(h, '/v1/ask', { token, json: { transcript_id: t.json.transcript_id, wait_seconds: 5 } });
      assert.equal(r.status, 201);
      assert.equal(r.json.reply_available, true);
      const id = r.json.request_id as string;
      const path = `/v1/ask/${id}/displayed`;

      assert.equal((await call(h, path, { token: VOICE_TOKEN, json: { page: 1 } })).status, 403); // Siri cannot "display"
      assert.equal((await call(h, path, { token: TOKEN, json: { page: 1 } })).status, 403);
      assert.equal((await call(h, `/v1/ask/${randomUUID()}/displayed`, { token, json: { page: 1 } })).status, 404);
      for (const bad of [{ page: 0 }, { page: 1.5 }, { page: 1, since_speech_end_ms: -1 }, { page: 1, since_speech_end_ms: 'x' }, { page: 1, since_speech_end_ms: 3_600_001 }])
        assert.equal((await call(h, path, { token, json: bad })).status, 400, JSON.stringify(bad));

      h.advance(1500);
      const first = await call(h, path, { token, json: { page: 1, since_speech_end_ms: 9300 } });
      assert.equal(first.status, 200);
      assert.equal(first.json.recorded, true);
      const again = await call(h, path, { token, json: { page: 1, since_speech_end_ms: 99999 } });
      assert.deepEqual([again.status, again.json.recorded], [200, false]);

      const ev = h.app.store.events(id).filter((e) => e.event === 'displayed');
      assert.equal(ev.length, 1);
      const detail = JSON.parse(ev[0]!.detail!);
      assert.equal(detail.page, 1);
      assert.equal(detail.since_speech_end_ms, 9300);
      assert.ok(detail.reply_to_display_ms >= 1500, String(detail.reply_to_display_ms));
      const line = h.logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.event === 'displayed');
      assert.ok(line && line.device_id === deviceId && line.request_id === id);
      assert.ok(!JSON.stringify(h.logs).includes('내일 일정'), 'no transcript text in logs');

      // A second paired device (different principal) cannot mark it.
      const other = await pair(h);
      assert.equal((await call(h, path, { token: other.token, json: { page: 1 } })).status, 404);
    } finally {
      await h.close();
    }
  });

  it('refuses before a reply exists', async () => {
    const h = await harness({ chris: 'none' });
    try {
      const { token } = await pair(h);
      const t = await call(h, '/v1/transcriptions', { token, body: pcm(2000, 4000) });
      const r = await call(h, '/v1/ask', { token, json: { transcript_id: t.json.transcript_id, wait_seconds: 0 } });
      const d = await call(h, `/v1/ask/${r.json.request_id}/displayed`, { token, json: { page: 1 } });
      assert.deepEqual([d.status, d.json.error_code], [409, 'reply_not_available']);
    } finally {
      await h.close();
    }
  });
});

describe('P1-03 real whisper.cpp (this Mac only; skipped if not installed)', () => {
  const bin = '/opt/homebrew/bin/whisper-cli';
  const model = `${process.env.HOME}/.cache/whisper/ggml-small.bin`;
  it('runs whisper on a short tone and removes its temp files', { skip: !(existsSync(bin) && existsSync(model)) }, async () => {
    const stt = () => readdirSync(tmpdir()).filter((f) => f.startsWith('relay-stt-')).sort();
    const before = stt();
    const w = new WhisperCli({ bin, modelPath: model });
    const out = await w.transcribe(pcm(1000, 3000));
    assert.equal(typeof out, 'string'); // content of a pure tone is meaningless; only the plumbing is checked
    assert.deepEqual(stt(), before, 'audio temp dir removed');
  });
});
