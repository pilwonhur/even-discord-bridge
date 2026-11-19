// AT-15 — install/run/stop/recover in an isolated temp environment, as a real
// child process via the documented commands. MOCK mode only; touches nothing outside
// the temp directory (no OpenClaw config, no daemon registration).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { TOKEN } from './helpers.ts';

const ROOT = resolve(import.meta.dirname, '..');

function startRelay(cwd: string, port: number): ChildProcess {
  return spawn(process.execPath, ['src/main.ts'], {
    cwd,
    env: {
      PATH: process.env.PATH,
      RELAY_MODE: 'mock',
      RELAY_PORT: String(port),
      RELAY_CLIENT_TOKEN: TOKEN,
      RELAY_PRINCIPAL_ID: 'owner',
      RELAY_DB_PATH: join(cwd, 'data', 'relay.sqlite'),
      RELAY_MOCK_CHRIS: 'request_id',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

async function waitReady(base: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if ((await r.json()).ready) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('relay did not become ready');
}

const stop = (p: ChildProcess) => new Promise<number | null>((res) => {
  p.once('exit', (code) => res(code));
  p.kill('SIGTERM');
});

describe('AT-15 설치·중지·복귀 (FR-14)', () => {
  it('runs from a fresh copy, completes a mock round trip, stops cleanly, and keeps state across restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-at15-'));
    for (const f of ['src', 'package.json']) cpSync(join(ROOT, f), join(dir, f), { recursive: true });
    const port = 20000 + Math.floor(Math.random() * 20000);
    const base = `http://127.0.0.1:${port}`;
    const auth = { authorization: `Bearer ${TOKEN}` };
    let p = startRelay(dir, port);
    let stderr = '';
    p.stderr!.on('data', (d) => (stderr += d));
    try {
      await waitReady(base);
      const key = randomUUID();
      const post = await fetch(`${base}/v1/requests`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ target: 'chris-primary', template: 'connection_check', arguments: {} }),
      });
      assert.equal(post.status, 202);
      const { request_id } = await post.json();
      let status = '';
      for (let i = 0; i < 60 && status !== 'completed'; i++) {
        await new Promise((r) => setTimeout(r, 100));
        status = (await (await fetch(`${base}/v1/requests/${request_id}`, { headers: auth })).json()).status;
      }
      assert.equal(status, 'completed');
      assert.equal(await stop(p), 0);

      p = startRelay(dir, port);
      await waitReady(base);
      const g = await (await fetch(`${base}/v1/requests/${request_id}`, { headers: auth })).json();
      assert.equal(g.status, 'completed');
      assert.match(g.reply_parts[0].text, /\[MOCK Chris\]/);
      const replay = await fetch(`${base}/v1/requests`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ target: 'chris-primary', template: 'connection_check', arguments: {} }),
      });
      assert.equal(replay.status, 200);
      assert.equal(await stop(p), 0);
      assert.ok(existsSync(join(dir, 'data', 'relay.sqlite')));
      assert.ok(!stderr.includes(TOKEN));
    } finally {
      if (p.exitCode === null) p.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
