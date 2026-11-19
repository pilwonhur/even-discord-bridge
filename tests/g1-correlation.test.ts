// AT-11..AT-13 — correlation, late replies, duplicates and loops. MOCK ONLY.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { correlate } from '../src/correlation.ts';
import type { IncomingMessage } from '../src/discord/types.ts';
import { chrisSays, harness } from './helpers.ts';

describe('AT-11 오응답 회수 방지 (FR-05)', () => {
  it('other bots, other channels, unreferenced and forged-ID messages are never attached; timeout → ambiguous_response', async () => {
    const h = await harness({ chris: 'silent' });
    try {
      const a = await h.post('connection_check');
      const id = a.json.request_id as string;
      const reqMsg = h.app.store.get(id)!.discord_message_id!;
      const cfg = h.app.config;
      // Another bot, even replying to the request with the right ID.
      h.fake.post({ authorId: '100000000000000007', authorIsBot: true, content: `요청 ID: ${id}\n가짜 답`, referenceMessageId: reqMsg });
      // Chris, but in another channel.
      h.fake.post({ authorId: cfg.chrisBotId, authorIsBot: true, content: `요청 ID: ${id}`, channelId: '900000000000000099' });
      // Chris, no reference, no request ID ("next message" must not be used).
      chrisSays(h, '다른 대화에 대한 답입니다');
      // Chris, with an unknown/forged request ID.
      chrisSays(h, `요청 ID: ${randomUUID()}`);
      await h.settle();
      let g = (await h.get(id)).json;
      assert.equal(g.status, 'awaiting_reply');
      assert.equal(g.reply_parts.length, 0);
      h.advance(cfg.replyTimeoutMs + 1);
      h.app.service.sweep();
      g = (await h.get(id)).json;
      assert.equal(g.status, 'ambiguous_response');
      assert.equal(g.reply_parts.length, 0);
      const reasons = h.app.store.unmatched().map((u) => u.reason);
      assert.deepEqual(reasons, ['non_target_author', 'other_channel', 'unreferenced', 'unreferenced']);
    } finally {
      await h.close();
    }
  });

  it('reference to one request but text naming another → ambiguous, not attached', async () => {
    const h = await harness({ chris: 'silent' });
    try {
      const a = await h.post('connection_check');
      chrisSays(h, `요청 ID: ${a.json.request_id}\n연결 확인`);
      await h.settle();
      const b = await h.post('recall_test_word');
      const bMsg = h.app.store.get(b.json.request_id)!.discord_message_id!;
      chrisSays(h, `요청 ID: ${a.json.request_id}\n사과`, bMsg);
      await h.settle();
      const g = (await h.get(b.json.request_id)).json;
      assert.equal(g.status, 'awaiting_reply');
      assert.equal(g.reply_parts.length, 0);
      assert.equal((await h.get(a.json.request_id)).json.reply_parts.length, 1);
    } finally {
      await h.close();
    }
  });

  for (const mode of ['reference', 'request_id'] as const) {
    it(`accepts the real Chris reply matched by ${mode}`, async () => {
      const h = await harness({ chris: mode });
      try {
        const a = await h.post('connection_check');
        await h.settle();
        const g = (await h.get(a.json.request_id)).json;
        assert.equal(g.status, 'completed');
        assert.equal(g.reply_parts.length, 1);
        assert.equal(g.reply_parts[0].match_basis, mode === 'reference' ? 'reference+request_id' : 'request_id_text');
        assert.equal(g.run_completion, 'unverified');
      } finally {
        await h.close();
      }
    });
  }

  it('pure correlate(): display names/timing play no role', () => {
    const ctx = {
      guildId: 'g',
      channelId: 'c',
      chrisBotId: 'chris',
      relayBotId: 'relay',
      requestByDiscordMessage: (m: string) => (m === 'm1' ? { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } : undefined),
      requestById: (i: string) => (['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'].includes(i) ? { id: i } : undefined),
    };
    const msg = (p: Partial<IncomingMessage>): IncomingMessage => ({
      type: 'create',
      id: 'x',
      channelId: 'c',
      guildId: 'g',
      authorId: 'chris',
      authorIsBot: true,
      content: '',
      referenceMessageId: null,
      editedTimestamp: null,
      hasAttachmentsOrEmbeds: false,
      ...p,
    });
    assert.deepEqual(correlate(msg({ authorId: 'relay' }), ctx), { kind: 'ignore', reason: 'self_author' });
    assert.deepEqual(correlate(msg({ guildId: 'other' }), ctx), { kind: 'ignore', reason: 'other_channel' });
    assert.equal(correlate(msg({ referenceMessageId: 'm1' }), ctx).kind, 'match');
    assert.equal(correlate(msg({ content: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }), ctx).kind, 'match');
    assert.deepEqual(correlate(msg({ content: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }), ctx), {
      kind: 'ambiguous',
      reason: 'multiple_request_ids',
      requestIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    });
  });
});

describe('AT-12 늦은 답 (FR-08)', () => {
  it('A times out, B is sent, A answer arrives → stored on A as late only; B untouched', async () => {
    const h = await harness({ chris: 'silent' });
    try {
      const a = await h.post('connection_check');
      h.advance(h.app.config.replyTimeoutMs + 1);
      h.app.service.sweep();
      assert.equal((await h.get(a.json.request_id)).json.status, 'timed_out');
      const b = await h.post('recall_test_word');
      assert.equal(b.status, 202);
      chrisSays(h, `요청 ID: ${a.json.request_id}\n늦은 연결 확인`);
      await h.settle();
      const ga = (await h.get(a.json.request_id)).json;
      const gb = (await h.get(b.json.request_id)).json;
      assert.equal(ga.status, 'timed_out');
      assert.equal(ga.late_reply_available, true);
      assert.equal(ga.reply_parts[0].late, true);
      assert.equal(gb.status, 'awaiting_reply');
      assert.equal(gb.reply_parts.length, 0);
      chrisSays(h, `요청 ID: ${b.json.request_id}\n사과`);
      await h.settle();
      const gb2 = (await h.get(b.json.request_id)).json;
      assert.equal(gb2.status, 'completed');
      assert.equal(gb2.reply_parts[0].text, `요청 ID: ${b.json.request_id}\n사과`);
    } finally {
      await h.close();
    }
  });
});

describe('AT-13 중복·루프 (FR-09)', () => {
  it('duplicate events stored once; own posts and Chris replies never create requests or auto-replies', async () => {
    const h = await harness({ chris: 'request_id' });
    try {
      const a = await h.post('connection_check');
      await h.settle();
      const relayMsg = h.fake.postsBy(h.app.config.relayBotId)[0]!;
      const chrisMsg = h.fake.postsBy(h.app.config.chrisBotId)[0]!;
      for (let i = 0; i < 3; i++) {
        h.fake.redeliver(chrisMsg.id);
        h.fake.redeliver(relayMsg.id);
      }
      await h.settle();
      const g = (await h.get(a.json.request_id)).json;
      assert.equal(g.reply_parts.length, 1);
      assert.equal(h.app.store.listRecent(100).length, 1); // no request created from Discord events
      assert.equal(h.relayPosts(), 1); // no auto-response loop
      // An edit of the reply updates the same part (no new part, no new request).
      h.fake.edit(chrisMsg.id, `요청 ID: ${a.json.request_id}\n연결 확인 (수정)`);
      h.fake.redeliver(chrisMsg.id, 'update');
      await h.settle();
      const g2 = (await h.get(a.json.request_id)).json;
      assert.equal(g2.reply_parts.length, 1);
      assert.match(g2.reply_parts[0].text, /수정/);
      assert.ok(g2.reply_parts[0].edited_at);
      assert.equal(g2.multipart_detected, false);
    } finally {
      await h.close();
    }
  });

  it('a second correlated Chris message is kept but flagged as unsupported multipart (P0)', async () => {
    const h = await harness({ chris: 'request_id' });
    try {
      const a = await h.post('connection_check');
      await h.settle();
      chrisSays(h, `요청 ID: ${a.json.request_id}\n추가 조각`);
      await h.settle();
      const g = (await h.get(a.json.request_id)).json;
      assert.equal(g.status, 'completed');
      assert.equal(g.reply_parts.length, 2);
      assert.equal(g.multipart_detected, true);
    } finally {
      await h.close();
    }
  });
});
