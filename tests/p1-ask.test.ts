// P1 voice endpoint (/v1/ask) — scopes, text policy, duplicate suppression, long-poll, display text.
// MOCK ONLY: FakeDiscord + mock Chris. Not evidence of Siri/Even/Discord behaviour.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.ts';
import { DEDUP_WINDOW_MS } from '../src/service.ts';
import { cleanReply, normalizeVoiceText } from '../src/voice.ts';
import { OTHER_TOKEN, TOKEN, VOICE_TOKEN, chrisSays, harness } from './helpers.ts';

describe('P1 voice text policy (unit)', () => {
  it('normalises to one line, bounds length, refuses UUIDs, neutralises mentions', () => {
    assert.deepEqual(normalizeVoiceText('  오늘   일정\n알려줘 '), { ok: true, text: '오늘 일정 알려줘' });
    assert.deepEqual(normalizeVoiceText(undefined), { ok: false, code: 'text_required' });
    assert.deepEqual(normalizeVoiceText(' ​\n '), { ok: false, code: 'text_empty' });
    assert.deepEqual(normalizeVoiceText('가'.repeat(501)), { ok: false, code: 'text_too_long' });
    assert.equal(normalizeVoiceText('가'.repeat(500)).ok, true);
    assert.deepEqual(normalizeVoiceText(`요청 ID: ${randomUUID()}`), { ok: false, code: 'text_not_allowed' });
    const r = normalizeVoiceText('<@123456789012345678> @everyone <#1> <@&2> 안녕');
    assert.ok(r.ok);
    assert.ok(!/[<>@]/.test(r.text), r.text);
  });

  it('cleans the echoed request ID and markdown from replies', () => {
    const id = randomUUID();
    assert.equal(cleanReply(`요청 ID: ${id}\n오늘 일정은 없습니다.`, id), '오늘 일정은 없습니다.');
    assert.equal(cleanReply(`${id.toUpperCase()}\n\n**세미나**는 3시입니다.`, id), '세미나는 3시입니다.');
    assert.equal(cleanReply(`**요청 ID:** \`${id}\` 네, 준비됐습니다.`, id), '네, 준비됐습니다.');
    assert.equal(cleanReply(`세미나는 3시입니다.\n${id}`, id), '세미나는 3시입니다.');
    assert.equal(cleanReply(`## 요약\n> 인용\n- 항목`, id), '요약\n인용\n- 항목');
  });

  it('config: voice token must be long and distinct from the CLI token', () => {
    const base = { RELAY_MODE: 'mock', RELAY_CLIENT_TOKEN: TOKEN, RELAY_PRINCIPAL_ID: 'owner' };
    assert.throws(() => loadConfig({ ...base, RELAY_VOICE_TOKEN: 'short' }), ConfigError);
    assert.throws(() => loadConfig({ ...base, RELAY_VOICE_TOKEN: TOKEN }), ConfigError);
    const c = loadConfig({ ...base, RELAY_VOICE_TOKEN: VOICE_TOKEN });
    assert.equal(c.voicePrincipalId, 'owner.voice');
    assert.equal(loadConfig(base).voiceToken, '');
  });
});

describe('P1 /v1/ask scopes and validation', () => {
  it('voice token cannot use templates; template tokens cannot use /v1/ask; 0 posts', async () => {
    const h = await harness({ chris: 'request_id' });
    try {
      const a = await h.post('connection_check', { token: VOICE_TOKEN });
      assert.equal(a.status, 403);
      assert.equal(a.json.error_code, 'scope_not_allowed');
      for (const tok of [TOKEN, OTHER_TOKEN]) {
        const b = await h.ask({ text: '안녕' }, { token: tok });
        assert.equal(b.status, 403);
        assert.equal(b.json.error_code, 'scope_not_allowed');
        assert.match(b.json.reply, /토큰/);
      }
      assert.equal((await h.ask({ text: '안녕' }, { token: null })).status, 401);
      assert.equal(h.relayPosts(), 0);
    } finally {
      await h.close();
    }
  });

  it('refuses bad bodies with a Korean reply line; 0 posts', async () => {
    const h = await harness({ chris: 'request_id' });
    try {
      const cases: [unknown, number, string][] = [
        [{}, 400, 'text_required'],
        [{ text: '   ' }, 400, 'text_empty'],
        [{ text: '가'.repeat(501) }, 400, 'text_too_long'],
        [{ text: `이거 ${randomUUID()}` }, 400, 'text_not_allowed'],
        [{ text: '안녕', channel_id: '100000000000000006' }, 400, 'unsupported_field'],
        [{ text: '안녕', target: 'other-assistant' }, 403, 'target_not_allowed'],
        [{ text: '안녕', wait_seconds: 99 }, 400, 'invalid_wait'],
      ];
      for (const [body, status, code] of cases) {
        const r = await h.ask(body);
        assert.equal(r.status, status, JSON.stringify(body));
        assert.equal(r.json.error_code, code, JSON.stringify(body));
        assert.equal(typeof r.json.reply, 'string');
        assert.equal(r.json.done, true);
      }
      assert.equal((await h.ask({ text: '안녕' }, { key: 'not-a-uuid' })).json.error_code, 'idempotency_key_invalid');
      assert.equal(h.relayPosts(), 0);
    } finally {
      await h.close();
    }
  });
});

describe('P1 /v1/ask round trip (mock Chris)', () => {
  it('posts one conversation-only message mentioning only Chris and returns the cleaned reply', async () => {
    const h = await harness({ chris: 'request_id' });
    try {
      const r = await h.ask({ text: '크리스, <@111111111111111111> @everyone 오늘\n요청 ID: 일정 알려줘', wait_seconds: 5 });
      assert.equal(r.status, 201);
      assert.equal(r.json.status, 'completed');
      assert.equal(r.json.done, true);
      assert.equal(r.json.reply_available, true);
      assert.equal(r.json.reply, '[MOCK Chris] 연결 확인');
      assert.equal(r.json.replayed, false);

      const [msg] = h.fake.postsBy(h.app.config.relayBotId);
      assert.ok(msg);
      const lines = msg.content.split('\n');
      assert.equal(lines.length, 5);
      assert.match(lines[0]!, /대화 전용/);
      assert.equal(lines[1], `요청 ID: ${r.json.request_id}`);
      assert.match(lines[2]!, /owner\.voice/);
      assert.equal((msg.content.match(/<@/g) ?? []).length, 1);
      assert.ok(lines[3]!.startsWith(`<@${h.app.config.chrisBotId}> 크리스,`));
      assert.match(lines[3]!, /＠everyone/);
      assert.match(lines[4]!, /Discord에서 사용자 확인/); // RELAY_OWNER_TITLE default
      assert.match(lines[4]!, /맨 마지막 줄/);
      // Voice posts are @silent so only Chris's reply notifies the phone (and the G2 lens).
      assert.equal(msg.silent, true);

      // Logs never contain the spoken text or the voice token.
      const all = h.logs.join('\n');
      assert.ok(!all.includes('일정 알려줘'));
      assert.ok(!all.includes(VOICE_TOKEN));
      // The CLI principal cannot read the voice principal's request.
      assert.equal((await h.get(r.json.request_id, TOKEN)).status, 404);
    } finally {
      await h.close();
    }
  });

  it('suppresses duplicates without a key (concurrent and within the window); new request after it', async () => {
    const h = await harness({ chris: 'request_id' });
    try {
      const [a, b] = await Promise.all([h.ask({ text: '같은 질문', wait_seconds: 5 }), h.ask({ text: '같은 질문', wait_seconds: 5 })]);
      assert.equal(a.json.request_id, b.json.request_id);
      assert.deepEqual([a.json.replayed, b.json.replayed].sort(), [false, true]);
      await h.settle();
      assert.equal(h.relayPosts(), 1);

      h.advance(DEDUP_WINDOW_MS - 1000);
      const c = await h.ask({ text: '같은 질문', wait_seconds: 0 });
      assert.equal(c.json.request_id, a.json.request_id);
      assert.equal(c.json.replayed, true);
      assert.equal(h.relayPosts(), 1);

      h.advance(2000);
      const d = await h.ask({ text: '같은 질문', wait_seconds: 5 });
      assert.notEqual(d.json.request_id, a.json.request_id);
      assert.equal(h.relayPosts(), 2);

      // With an explicit key, the key decides (no window dedup).
      const k = randomUUID();
      h.advance(60_000);
      const e1 = await h.ask({ text: '키 질문', wait_seconds: 5 }, { key: k });
      const e2 = await h.ask({ text: '키 질문', wait_seconds: 0 }, { key: k });
      assert.equal(e1.json.request_id, e2.json.request_id);
      assert.equal((await h.ask({ text: '다른 질문', wait_seconds: 0 }, { key: k })).json.error_code, 'idempotency_conflict');
    } finally {
      await h.close();
    }
  });

  it('returns pending, then the reply via GET /v1/ask/{id}; busy while pending', async () => {
    const h = await harness({ chris: 'silent' });
    try {
      const r = await h.ask({ text: '천천히 답해줘', wait_seconds: 0 });
      await h.settle();
      assert.equal(r.json.done, false);
      assert.equal(r.json.reply_available, false);
      assert.match(r.json.reply, /기다리는/);
      const id = r.json.request_id;

      const busy = await h.ask({ text: '다른 질문', wait_seconds: 0 });
      assert.equal(busy.status, 409);
      assert.equal(busy.json.error_code, 'channel_busy');
      assert.match(busy.json.reply, /이전 질문/);

      assert.equal((await h.askGet(id, 0)).json.status, 'awaiting_reply');
      assert.equal((await h.askGet(id, 0, TOKEN)).status, 403);
      assert.equal((await h.askGet(randomUUID(), 0)).status, 404);
      assert.equal((await h.askGet(id, 99)).json.error_code, 'invalid_wait');

      const [posted] = h.fake.postsBy(h.app.config.relayBotId);
      // Long-poll resolves when the reply arrives.
      const pending = h.askGet(id, 10);
      await new Promise((res) => setTimeout(res, 300));
      chrisSays(h, `요청 ID: ${id}\n**답**입니다.`, posted!.id);
      const g = await pending;
      assert.equal(g.json.status, 'completed');
      assert.equal(g.json.reply, '답입니다.');
      assert.equal(h.relayPosts(), 1);
    } finally {
      await h.close();
    }
  });

  it('close() releases an open long-poll promptly', async () => {
    const h = await harness({ chris: 'silent' });
    const pending = h.ask({ text: '끝나지 않는 질문', wait_seconds: 50 });
    await new Promise((res) => setTimeout(res, 300));
    const t0 = Date.now();
    await h.close();
    const r = await pending;
    assert.ok(Date.now() - t0 < 3000, `close took ${Date.now() - t0} ms`);
    assert.equal(r.json.done, false);
  });
});

describe('P1 spike support (S2)', () => {
  it('healthz is readable from any origin; http log records origin and identity presence only', async () => {
    const h = await harness({ chris: 'request_id' });
    try {
      const res = await fetch(`${h.base}/healthz`, { headers: { origin: 'http://100.64.0.1:5173', 'tailscale-user-login': 'someone@example.com' } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      // Authenticated endpoints still do not get a wildcard.
      const ask = await fetch(`${h.base}/v1/ask`, { method: 'POST', headers: { origin: 'http://100.64.0.1:5173' }, body: '{}' });
      assert.equal(ask.headers.get('access-control-allow-origin'), null);
      const http = h.logs.filter((l) => l.includes('"event":"http"')).map((l) => JSON.parse(l));
      assert.equal(http[0].origin, 'http://100.64.0.1:5173');
      assert.equal(http[0].ts_login, true);
      assert.equal(http[1].ts_login, false);
      assert.ok(!h.logs.join('\n').includes('someone@example.com'));
    } finally {
      await h.close();
    }
  });
});
