// Test harness: mock-mode app on an ephemeral loopback port with a shared FakeDiscord,
// a controllable clock, a recording sleep and a captured log sink.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { FakeDiscord } from '../src/discord/fake.ts';
import type { MockChrisMode } from '../src/discord/fake.ts';
import { createLogger } from '../src/log.ts';
import { FakeTranscriber } from '../src/stt.ts';
import type { Transcriber } from '../src/stt.ts';

export const TOKEN = 'test-client-token-0123456789abcdef0123456789';
export const OTHER_TOKEN = 'other-principal-token-0123456789abcdef01234';
export const VOICE_TOKEN = 'voice-client-token-0123456789abcdef0123456789';
export const FAKE_BOT_TOKEN = 'MTAwMDAwMDAwMDAwMDAwMDAx.GabcDE.abcdefghijklmnopqrstuvwxyz0123456789AB';

export interface Harness {
  app: App;
  fake: FakeDiscord;
  base: string;
  dir: string;
  logs: string[];
  sleeps: number[];
  clock: { t: number };
  advance(ms: number): void;
  post(template: string, opts?: { key?: string; token?: string | null; body?: unknown; target?: string }): Promise<{ status: number; json: any }>;
  get(id: string, token?: string | null): Promise<{ status: number; json: any }>;
  /** P1: POST /v1/ask with the voice token by default. Does not settle (the call itself long-polls). */
  ask(body: unknown, opts?: { token?: string | null; key?: string }): Promise<{ status: number; json: any }>;
  askGet(id: string, wait?: number, token?: string | null): Promise<{ status: number; json: any }>;
  settle(): Promise<void>;
  restart(): Promise<void>;
  close(): Promise<void>;
  relayPosts(): number;
}

export async function harness(
  o: { chris?: MockChrisMode; contentIntent?: boolean; readinessProblems?: string[]; dir?: string; fake?: FakeDiscord; transcriber?: Transcriber } = {},
): Promise<Harness> {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'relay-test-'));
  const env = {
    RELAY_MODE: 'mock',
    RELAY_CLIENT_TOKEN: TOKEN,
    RELAY_PRINCIPAL_ID: 'owner',
    RELAY_DB_PATH: join(dir, 'relay.sqlite'),
    DISCORD_BOT_TOKEN: FAKE_BOT_TOKEN,
    RELAY_RATE_LIMIT_PER_MINUTE: '1000',
    RELAY_VOICE_TOKEN: VOICE_TOKEN,
  };
  const config = { ...loadConfig(env), port: 0 };
  const fake =
    o.fake ??
    new FakeDiscord({
      guildId: config.guildId,
      channelId: config.channelId,
      relayBotId: config.relayBotId,
      chrisBotId: config.chrisBotId,
      messageContentIntent: o.contentIntent ?? true,
      readinessProblems: o.readinessProblems ?? [],
      chris: { mode: o.chris ?? 'silent', delayMs: 0 },
    });
  const logs: string[] = [];
  const sleeps: number[] = [];
  const clock = { t: Date.UTC(2026, 10, 16, 12, 0, 0) };

  const build = () =>
    createApp(config, {
      adapter: fake,
      logger: createLogger([config.clientToken, config.discordBotToken, OTHER_TOKEN, VOICE_TOKEN], (l) => logs.push(l)),
      now: () => clock.t,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      sweepIntervalMs: 0,
      extraPrincipals: [{ principalId: 'someone-else', token: OTHER_TOKEN }],
      transcriber: o.transcriber ?? new FakeTranscriber(),
    });

  let app = build();
  let base = `http://127.0.0.1:${await app.listen()}`;

  const h: Harness = {
    get app() {
      return app;
    },
    fake,
    get base() {
      return base;
    },
    dir,
    logs,
    sleeps,
    clock,
    advance(ms) {
      clock.t += ms;
    },
    async post(template, p = {}) {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-key': p.key ?? randomUUID() };
      const tok = p.token === undefined ? TOKEN : p.token;
      if (tok !== null) headers.authorization = `Bearer ${tok}`;
      const body = p.body ?? { target: p.target ?? 'chris-primary', template, arguments: {} };
      const res = await fetch(`${base}/v1/requests`, { method: 'POST', headers, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      await h.settle();
      return { status: res.status, json };
    },
    async get(id, token = TOKEN) {
      const headers: Record<string, string> = {};
      if (token !== null) headers.authorization = `Bearer ${token}`;
      const res = await fetch(`${base}/v1/requests/${id}`, { headers });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    },
    async ask(body, p = {}) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (p.key) headers['idempotency-key'] = p.key;
      const tok = p.token === undefined ? VOICE_TOKEN : p.token;
      if (tok !== null) headers.authorization = `Bearer ${tok}`;
      const res = await fetch(`${base}/v1/ask`, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    },
    async askGet(id, wait = 0, token = VOICE_TOKEN) {
      const headers: Record<string, string> = {};
      if (token !== null) headers.authorization = `Bearer ${token}`;
      const res = await fetch(`${base}/v1/ask/${id}?wait=${wait}`, { headers });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    },
    async settle() {
      // Let FakeDiscord's setTimeout-based mock replies (delay 0 → ≥1ms) fire.
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 2));
        await app.service.idle();
      }
    },
    async restart() {
      await app.close();
      app = build();
      base = `http://127.0.0.1:${await app.listen()}`;
      await h.settle();
    },
    async close() {
      await app.close();
      if (!o.dir) rmSync(dir, { recursive: true, force: true });
    },
    relayPosts() {
      return fake.postsBy(config.relayBotId).length;
    },
  };
  await h.settle();
  return h;
}

/** Posts a message as the (mock) Chris bot. */
export function chrisSays(h: Harness, content: string, referenceMessageId: string | null = null) {
  return h.fake.post({ authorId: h.app.config.chrisBotId, authorIsBot: true, content, referenceMessageId });
}
