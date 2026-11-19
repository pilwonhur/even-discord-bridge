// AT-06..AT-10 — send failures, lost responses, restart recovery, 429/disconnect,
// permissions/content access. MOCK ONLY (FakeDiscord).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { bodyHash } from '../src/service.ts';
import { renderRequest } from '../src/templates.ts';
import { chrisSays, harness } from './helpers.ts';

describe('AT-06 게시 전 실패 (FR-08)', () => {
  for (const kind of ['not_sent', 'throw'] as const) {
    it(`${kind}: failed with a distinct error_code, never completed, channel released`, async () => {
      const h = await harness();
      try {
        h.fake.injectFault({ kind });
        const a = await h.post('connection_check');
        assert.equal(a.status, 202);
        const g = await h.get(a.json.request_id);
        assert.equal(g.json.status, 'failed');
        assert.equal(g.json.error_code, kind === 'not_sent' ? 'fake_connection_refused' : 'pre_send_exception');
        assert.equal(g.json.reply_parts.length, 0);
        assert.equal(h.relayPosts(), 0);
        assert.equal(h.fake.sendAttempts.length, 1); // no automatic retry in P0
        assert.equal((await h.post('connection_check')).status, 202); // lock released
      } finally {
        await h.close();
      }
    });
  }
});

describe('AT-07 게시 응답 유실 (FR-06)', () => {
  it('message created but response lost → delivery_unknown → recovered by own-post scan, no re-post', async () => {
    const h = await harness({ chris: 'silent' });
    try {
      h.fake.injectFault({ kind: 'lost_response' });
      const a = await h.post('connection_check');
      const g = await h.get(a.json.request_id);
      assert.equal(g.json.status, 'awaiting_reply');
      assert.equal(g.json.discord_request_message_id, h.fake.postsBy(h.app.config.relayBotId)[0]!.id);
      const events = h.app.store.events(a.json.request_id).map((e) => e.event);
      assert.deepEqual(events, ['accepted', 'sending', 'delivery_unknown', 'awaiting_reply']);
      assert.equal(h.relayPosts(), 1);
      assert.equal(h.fake.sendAttempts.length, 1);
    } finally {
      await h.close();
    }
  });

  it('outcome unknown and not found → stays delivery_unknown and busy; nothing re-posted; operator can release', async () => {
    const h = await harness({ chris: 'silent' });
    try {
      h.fake.injectFault({ kind: 'unknown_without_post' });
      const a = await h.post('connection_check');
      let g = await h.get(a.json.request_id);
      assert.equal(g.json.status, 'delivery_unknown');
      assert.equal((await h.post('connection_check')).json.error_code, 'channel_busy');
      await h.restart(); // restart must not re-post either
      g = await h.get(a.json.request_id);
      assert.equal(g.json.status, 'delivery_unknown');
      assert.equal(h.relayPosts(), 0);
      assert.equal(h.fake.sendAttempts.length, 1);
      assert.ok(h.app.store.transition(a.json.request_id, ['delivery_unknown'], 'failed', h.clock.t, { error_code: 'operator_marked_failed' }));
      assert.equal((await h.post('connection_check')).status, 202);
    } finally {
      await h.close();
    }
  });
});

describe('AT-08 재시작 복구 (FR-06, FR-14)', () => {
  it('awaiting_reply survives restart with the same IDs; idempotent replay still works; no re-post', async () => {
    const h = await harness({ chris: 'silent' });
    try {
      const key = randomUUID();
      const a = await h.post('recall_test_word', { key });
      const before = (await h.get(a.json.request_id)).json;
      await h.restart();
      const after = (await h.get(a.json.request_id)).json;
      assert.equal(after.status, 'awaiting_reply');
      assert.equal(after.discord_request_message_id, before.discord_request_message_id);
      const replay = await h.post('recall_test_word', { key });
      assert.equal(replay.status, 200);
      assert.equal(replay.json.request_id, a.json.request_id);
      assert.equal(h.relayPosts(), 1);
      chrisSays(h, `요청 ID: ${a.json.request_id}\n사과`);
      await h.settle();
      assert.equal((await h.get(a.json.request_id)).json.status, 'completed');
    } finally {
      await h.close();
    }
  });

  const seed = (h: Awaited<ReturnType<typeof harness>>, status: 'accepted' | 'sending') => {
    const id = randomUUID();
    const s = h.app.store;
    s.insertAccepted(
      {
        id,
        principal_id: 'owner',
        idempotency_key: randomUUID(),
        body_hash: bodyHash('chris-primary', 'connection_check'),
        target: 'chris-primary',
        channel_id: h.app.config.channelId,
        template: 'connection_check',
        rendered_text: renderRequest({ requestId: id, principalId: 'owner', chrisBotId: h.app.config.chrisBotId, template: 'connection_check' }),
        nonce: id.replace(/-/g, '').slice(0, 25),
      },
      h.clock.t,
    );
    if (status === 'sending') s.transition(id, ['accepted'], 'sending', h.clock.t);
    return id;
  };

  it('crash in "sending" before the post → delivery_unknown after restart, no blind resend', async () => {
    const h = await harness({ chris: 'silent' });
    try {
      const id = seed(h, 'sending');
      await h.restart();
      assert.equal((await h.get(id)).json.status, 'delivery_unknown');
      assert.equal((await h.get(id)).json.error_code, 'interrupted_during_send');
      assert.equal(h.fake.sendAttempts.length, 0);
    } finally {
      await h.close();
    }
  });

  it('crash in "sending" after the post → recovered from own post, still one post', async () => {
    const h = await harness({ chris: 'silent' });
    try {
      const id = seed(h, 'sending');
      const r = h.app.store.get(id)!;
      h.fake.post({ authorId: h.app.config.relayBotId, authorIsBot: true, content: r.rendered_text!, nonce: r.nonce });
      await h.restart();
      const g = (await h.get(id)).json;
      assert.equal(g.status, 'awaiting_reply');
      assert.equal(g.discord_request_message_id, h.fake.postsBy(h.app.config.relayBotId)[0]!.id);
      assert.equal(h.relayPosts(), 1);
      assert.equal(h.fake.sendAttempts.length, 0);
    } finally {
      await h.close();
    }
  });

  it('"accepted" (never attempted) is dispatched exactly once after restart', async () => {
    const h = await harness({ chris: 'silent' });
    try {
      const id = seed(h, 'accepted');
      await h.restart();
      assert.equal((await h.get(id)).json.status, 'awaiting_reply');
      await h.restart();
      assert.equal(h.relayPosts(), 1);
      assert.equal(h.fake.sendAttempts.length, 1);
    } finally {
      await h.close();
    }
  });
});

describe('AT-09 429/연결 끊김 (FR-08)', () => {
  it('honours Retry-After on 429, then posts once', async () => {
    const h = await harness({ chris: 'silent' });
    try {
      h.fake.injectFault({ kind: 'rate_limited', retryAfterMs: 1500 });
      h.fake.injectFault({ kind: 'rate_limited', retryAfterMs: 2750 });
      const a = await h.post('connection_check');
      assert.deepEqual(h.sleeps, [1500, 2750]);
      assert.equal((await h.get(a.json.request_id)).json.status, 'awaiting_reply');
      assert.equal(h.relayPosts(), 1);
      assert.equal(h.fake.sendAttempts.length, 3);
    } finally {
      await h.close();
    }
  });

  it('gives up after bounded 429 retries without posting', async () => {
    const h = await harness({ chris: 'silent' });
    try {
      for (let i = 0; i < 6; i++) h.fake.injectFault({ kind: 'rate_limited', retryAfterMs: 1000 });
      const a = await h.post('connection_check');
      const g = (await h.get(a.json.request_id)).json;
      assert.equal(g.status, 'failed');
      assert.equal(g.error_code, 'rate_limit_retries_exhausted');
      assert.equal(h.relayPosts(), 0);
    } finally {
      await h.close();
    }
  });

  it('gateway disconnect: POST refused while down; missed reply recovered by bounded catch-up exactly once', async () => {
    const h = await harness({ chris: 'silent' });
    try {
      const a = await h.post('connection_check');
      h.fake.disconnect();
      assert.equal((await h.post('connection_check')).status, 503);
      const reply = chrisSays(h, `요청 ID: ${a.json.request_id}\n연결 확인`); // not delivered (disconnected)
      await h.settle();
      assert.equal((await h.get(a.json.request_id)).json.status, 'awaiting_reply');
      h.fake.reconnect();
      await h.settle();
      h.fake.redeliver(reply.id); // the gateway may also replay it
      h.fake.reconnect(); // and a second catch-up runs
      await h.settle();
      const g = (await h.get(a.json.request_id)).json;
      assert.equal(g.status, 'completed');
      assert.equal(g.reply_parts.length, 1);
      assert.equal(h.relayPosts(), 1);
    } finally {
      await h.close();
    }
  });
});

describe('AT-10 권한·본문 접근 (FR-11)', () => {
  it('missing Message Content Intent / permission → explicit not-ready, 503, 0 posts', async () => {
    for (const o of [{ contentIntent: false }, { readinessProblems: ['missing_permission_send_messages'] }]) {
      const h = await harness(o);
      try {
        const health = await (await fetch(`${h.base}/healthz`)).json();
        assert.equal(health.ready, false);
        const r = await h.post('connection_check');
        assert.equal(r.status, 503);
        assert.equal(r.json.error_code, 'relay_not_ready');
        assert.equal(h.relayPosts(), 0);
      } finally {
        await h.close();
      }
    }
  });

  it('a correlated reply with empty content is never reported as success', async () => {
    const h = await harness({ chris: 'reference' });
    try {
      h.fake.opts.messageContentIntent = false; // content access lost after startup
      const a = await h.post('connection_check');
      await h.settle();
      const g = (await h.get(a.json.request_id)).json;
      assert.equal(g.status, 'failed');
      assert.equal(g.error_code, 'reply_content_unavailable');
      assert.equal(g.reply_parts[0].text, null);
    } finally {
      await h.close();
    }
  });
});

describe('config fail-fast', () => {
  it('live mode without IDs/token and non-loopback binds are refused', async () => {
    const { loadConfig, ConfigError } = await import('../src/config.ts');
    const base = { RELAY_CLIENT_TOKEN: 'x'.repeat(40), RELAY_PRINCIPAL_ID: 'owner' };
    assert.throws(() => loadConfig({ ...base, RELAY_MODE: 'live' }), ConfigError);
    assert.throws(() => loadConfig({ ...base, RELAY_BIND_HOST: '0.0.0.0' }), ConfigError);
    assert.throws(() => loadConfig({ RELAY_PRINCIPAL_ID: 'p' }), ConfigError);
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    try {
      const ok = loadConfig({
        ...base,
        RELAY_MODE: 'live',
        DISCORD_BOT_TOKEN: 'x',
        DISCORD_GUILD_ID: '100000000000000001',
        DISCORD_CHANNEL_ID: '100000000000000002',
        DISCORD_RELAY_BOT_ID: '100000000000000003',
        DISCORD_CHRIS_BOT_ID: '100000000000000004',
      });
      assert.equal(ok.mode, 'live');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('real adapter: permission computation (unit, no network)', () => {
  it('computes base + overwrites and flags Administrator', async () => {
    const { computePermissions } = await import('../src/discord/real.ts');
    const G = 'g';
    const VIEW = 1n << 10n, SEND = 1n << 11n, HIST = 1n << 16n;
    const roles = [{ id: G, permissions: String(VIEW | SEND | HIST) }, { id: 'r1', permissions: '0' }, { id: 'admin', permissions: String(1n << 3n) }];
    let p = computePermissions(G, ['r1'], roles, [], 'bot');
    assert.equal(p.value & (VIEW | SEND | HIST), VIEW | SEND | HIST);
    // @everyone denied SEND in the channel, role r1 allowed it back, member overwrite denies HIST.
    p = computePermissions(G, ['r1'], roles, [
      { id: G, type: 0, allow: '0', deny: String(SEND) },
      { id: 'r1', type: 0, allow: String(SEND), deny: '0' },
      { id: 'bot', type: 1, allow: '0', deny: String(HIST) },
    ], 'bot');
    assert.equal(p.value & SEND, SEND);
    assert.equal(p.value & HIST, 0n);
    assert.equal(computePermissions(G, ['admin'], roles, [], 'bot').admin, true);
  });
});
