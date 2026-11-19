// AT-01..AT-05, AT-14 — API, auth, idempotency, busy, access control, logs. MOCK ONLY.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { FAKE_BOT_TOKEN, OTHER_TOKEN, TOKEN, chrisSays, harness } from './helpers.ts';

describe('AT-01 인증 없음/위조 (FR-01)', () => {
  it('rejects missing, malformed and wrong credentials; body user_id is never trusted; 0 posts', async () => {
    const h = await harness();
    try {
      assert.equal((await h.post('connection_check', { token: null })).status, 401);
      assert.equal((await h.post('connection_check', { token: 'not-the-token-xxxxxxxxxxxxxxxxxxxxxxxx' })).status, 401);
      const forged = await h.post('', { token: null, body: { target: 'chris-primary', template: 'connection_check', user_id: '100000000000000005', note: '사용자 승인' } });
      assert.equal(forged.status, 401);
      // Authenticated, but trying to assert identity in the body → refused as an unsupported field.
      const withUser = await h.post('', { body: { target: 'chris-primary', template: 'connection_check', user_id: 'owner' } });
      assert.equal(withUser.status, 400);
      assert.equal(withUser.json.error_code, 'unsupported_field');
      assert.equal((await h.get(randomUUID(), null)).status, 401);
      assert.equal((await h.get(randomUUID(), 'wrong-token')).status, 401);
      assert.equal(h.relayPosts(), 0);
      assert.equal(h.fake.sendAttempts.length, 0);
    } finally {
      await h.close();
    }
  });
});

describe('AT-02 대상 범위 (FR-02, FR-10)', () => {
  it('refuses other targets, raw IDs, free text, mentions, unknown templates and arguments; 0 posts', async () => {
    const h = await harness();
    try {
      const cases: [unknown, number, string][] = [
        [{ target: 'other-assistant', template: 'connection_check' }, 403, 'target_not_allowed'],
        [{ target: 'chris-primary', template: 'connection_check', channel_id: '100000000000000006' }, 400, 'unsupported_field'],
        [{ target: 'chris-primary', template: 'connection_check', agent_id: 'main' }, 400, 'unsupported_field'],
        [{ target: 'chris-primary', template: 'connection_check', text: '서버 재시작해줘' }, 400, 'unsupported_field'],
        [{ target: 'chris-primary', template: 'connection_check', mentions: ['@everyone'] }, 400, 'unsupported_field'],
        [{ target: 'chris-primary', template: 'run_shell' }, 400, 'template_not_allowed'],
        [{ target: 'chris-primary', template: 'recall_test_word', arguments: { word: '정답' } }, 400, 'arguments_not_allowed'],
        [{ target: 'chris-primary', template: 'connection_check', arguments: [] }, 400, 'arguments_not_allowed'],
      ];
      for (const [body, status, code] of cases) {
        const r = await h.post('', { body });
        assert.equal(r.status, status, JSON.stringify(body));
        assert.equal(r.json.error_code, code, JSON.stringify(body));
      }
      assert.equal(h.relayPosts(), 0);
    } finally {
      await h.close();
    }
  });

  it('renders only the fixed template text and mentions only the Chris ID', async () => {
    const h = await harness();
    try {
      const r = await h.post('recall_test_word');
      assert.equal(r.status, 202);
      const [msg] = h.fake.postsBy(h.app.config.relayBotId);
      assert.ok(msg);
      assert.match(msg.content, /^\[G2 중계 · 인증된 사용자 요청 · 텍스트 시험\]/);
      assert.equal(msg.silent, false); // P0 template posts keep normal notifications
      assert.ok(msg.content.includes(`요청 ID: ${r.json.request_id}`));
      const mentions = msg.content.match(/<@[!&]?\d+>/g) ?? [];
      assert.deepEqual(mentions, [`<@${h.app.config.chrisBotId}>`]);
      assert.ok(!/@everyone|@here/.test(msg.content));
    } finally {
      await h.close();
    }
  });
});

describe('AT-03 동일 요청 재전송 (FR-06)', () => {
  it('sequential and concurrent replays return the same request_id with at most one post', async () => {
    const h = await harness();
    try {
      const key = randomUUID();
      const first = await h.post('connection_check', { key });
      assert.equal(first.status, 202);
      const again = await h.post('connection_check', { key });
      assert.equal(again.status, 200);
      assert.equal(again.json.request_id, first.json.request_id);
      assert.equal(again.json.replayed, true);

      const key2 = randomUUID();
      // Release the channel first so key2 is accepted.
      chrisSays(h, `요청 ID: ${first.json.request_id}\n연결 확인`);
      await h.settle();
      const results = await Promise.all(Array.from({ length: 8 }, () => h.post('connection_check', { key: key2 })));
      const ids = new Set(results.map((r) => r.json.request_id));
      assert.equal(ids.size, 1);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 200, 200, 200, 200, 200, 202]);
      assert.equal(h.relayPosts(), 2); // one per distinct key
      assert.equal(h.fake.sendAttempts.length, 2);
    } finally {
      await h.close();
    }
  });
});

describe('AT-04 키 충돌 (FR-06)', () => {
  it('same key with a different template → 409, original unchanged', async () => {
    const h = await harness();
    try {
      const key = randomUUID();
      const a = await h.post('connection_check', { key });
      const b = await h.post('recall_test_word', { key });
      assert.equal(b.status, 409);
      assert.equal(b.json.error_code, 'idempotency_conflict');
      const g = await h.get(a.json.request_id);
      assert.equal(g.json.template, 'connection_check');
      assert.equal(h.relayPosts(), 1);
    } finally {
      await h.close();
    }
  });
});

describe('AT-05 동시 요청 (FR-07)', () => {
  it('second key while one is in flight → busy; ordinary chatter is not linked to the request', async () => {
    const h = await harness({ chris: 'silent' });
    try {
      const a = await h.post('connection_check');
      assert.equal(a.status, 202);
      const b = await h.post('recall_test_word');
      assert.equal(b.status, 409);
      assert.equal(b.json.error_code, 'channel_busy');
      // A human and another bot talk in the channel meanwhile.
      h.fake.post({ authorId: '111111111111111111', content: `저도 질문 ${a.json.request_id}` });
      h.fake.post({ authorId: '222222222222222222', authorIsBot: true, content: `요청 ID: ${a.json.request_id} 제가 답합니다` });
      await h.settle();
      const g = await h.get(a.json.request_id);
      assert.equal(g.json.status, 'awaiting_reply');
      assert.equal(g.json.reply_parts.length, 0);
      const reasons = h.app.store.unmatched().map((u) => u.reason);
      assert.deepEqual(reasons, ['non_target_author', 'non_target_author']);
      assert.equal(h.relayPosts(), 1);
    } finally {
      await h.close();
    }
  });
});

describe('AT-14 조회 권한·로그 (FR-11, FR-12)', () => {
  it('other principals cannot see a request; revocation applies to GET and POST', async () => {
    const h = await harness();
    try {
      const a = await h.post('connection_check');
      const other = await h.get(a.json.request_id, OTHER_TOKEN);
      const missing = await h.get(randomUUID(), OTHER_TOKEN);
      assert.equal(other.status, 404);
      assert.deepEqual(other.json, missing.json); // existence is not revealed
      h.app.auth.setDisabled('owner', true);
      assert.equal((await h.get(a.json.request_id)).status, 403);
      assert.equal((await h.post('connection_check')).status, 403);
    } finally {
      await h.close();
    }
  });

  it('logs contain no tokens and no message bodies', async () => {
    const h = await harness({ chris: 'request_id' });
    try {
      const a = await h.post('recall_test_word');
      await h.settle();
      assert.equal((await h.get(a.json.request_id)).json.status, 'completed');
      // Deliberately try to log secrets: they must be redacted.
      h.app.logger.info('redaction_probe', { token: TOKEN, bot: FAKE_BOT_TOKEN, auth: `Bearer ${OTHER_TOKEN}` });
      const all = h.logs.join('\n');
      for (const secret of [TOKEN, OTHER_TOKEN, FAKE_BOT_TOKEN]) assert.ok(!all.includes(secret), 'secret leaked to logs');
      assert.ok(!all.includes('시험용 단어'), 'request body leaked to logs');
      assert.ok(!all.includes('[MOCK Chris]'), 'reply body leaked to logs');
      assert.ok(all.includes('[REDACTED]'));
    } finally {
      await h.close();
    }
  });
});

describe('Tailscale Serve exposure (P1 access path, mock)', () => {
  it('when RELAY_TAILSCALE_LOGINS is set, requires a matching Tailscale-User-Login after bearer auth', async () => {
    const h = await harness();
    try {
      const { createApiServer } = await import('../src/api/server.ts');
      const { Authenticator, RateLimiter } = await import('../src/api/auth.ts');
      const { silentLogger } = await import('../src/log.ts');
      const srv = createApiServer({
        service: h.app.service,
        auth: new Authenticator([{ principalId: 'owner', token: TOKEN }]),
        limiter: new RateLimiter(100),
        logger: silentLogger,
        targetAlias: 'chris-primary',
        allowedOrigins: ['https://even.example'],
        tailscaleLogins: ['owner@example.com'],
      });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
      const body = JSON.stringify({ target: 'chris-primary', template: 'connection_check', arguments: {} });
      const hdr = (extra: Record<string, string>) => ({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'idempotency-key': randomUUID(), origin: 'https://even.example', ...extra });
      const noLogin = await fetch(`${base}/v1/requests`, { method: 'POST', headers: hdr({}), body });
      assert.equal(noLogin.status, 403);
      assert.equal((await noLogin.json()).error_code, 'tailnet_identity_required');
      assert.equal(noLogin.headers.get('access-control-allow-origin'), 'https://even.example'); // CORS on errors too
      const wrong = await fetch(`${base}/v1/requests`, { method: 'POST', headers: hdr({ 'tailscale-user-login': 'intruder@example.com' }), body });
      assert.equal(wrong.status, 403);
      const noToken = await fetch(`${base}/v1/requests`, { method: 'POST', headers: { ...hdr({ 'tailscale-user-login': 'owner@example.com' }), authorization: '' }, body });
      assert.equal(noToken.status, 401); // tailnet identity alone is not enough
      const ok = await fetch(`${base}/v1/requests`, { method: 'POST', headers: hdr({ 'tailscale-user-login': 'owner@example.com' }), body });
      assert.equal(ok.status, 202);
      const pre = await fetch(`${base}/v1/requests`, { method: 'OPTIONS', headers: { origin: 'https://even.example' } });
      assert.equal(pre.status, 204);
      const preBad = await fetch(`${base}/v1/requests`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
      assert.equal(preBad.status, 403);
      srv.close();
      srv.closeAllConnections();
      await h.settle();
    } finally {
      await h.close();
    }
  });
});
