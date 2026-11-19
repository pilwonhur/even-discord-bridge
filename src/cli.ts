// P0 test client (I-05). Choose a template, send, poll status.
//   node src/cli.ts send <connection_check|recall_test_word|sentence_with_test_word> [--key <uuid>] [--wait]
//   node src/cli.ts get <request_id>
//   node src/cli.ts health
//   node src/cli.ts ask "<문장>" [--wait 25]        (P1 /v1/ask, uses RELAY_VOICE_TOKEN)
// Env: RELAY_URL (default http://127.0.0.1:8787), RELAY_CLIENT_TOKEN, RELAY_VOICE_TOKEN
import { randomUUID } from 'node:crypto';

const base = process.env.RELAY_URL || `http://127.0.0.1:${process.env.RELAY_PORT || 8787}`;
const token = process.env.RELAY_CLIENT_TOKEN || '';
const target = process.env.RELAY_TARGET_ALIAS || 'chris-primary';
const TERMINAL = new Set(['completed', 'failed', 'timed_out', 'ambiguous_response']);

const [cmd, arg, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? (rest[i + 1] ?? '') : undefined;
};

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function print(x: unknown) {
  process.stdout.write(JSON.stringify(x, null, 2) + '\n');
}

if (cmd === 'health') {
  const r = await fetch(base + '/healthz');
  print({ status: r.status, ...(await r.json()) });
} else if (cmd === 'send' && arg) {
  const key = flag('--key') || randomUUID();
  const r = await call('POST', '/v1/requests', { target, template: arg, arguments: {} }, { 'idempotency-key': key });
  print({ http: r.status, idempotency_key: key, ...r.json });
  if (rest.includes('--wait') && (r.status === 202 || r.status === 200)) {
    const id = (r.json as { request_id: string }).request_id;
    for (;;) {
      await new Promise((res) => setTimeout(res, 2000));
      const g = await call('GET', `/v1/requests/${id}`);
      const s = (g.json as { status?: string }).status;
      process.stderr.write(`status=${s}\n`);
      if (!s || TERMINAL.has(s)) {
        print(g.json);
        break;
      }
    }
  }
} else if (cmd === 'ask' && arg) {
  const res = await fetch(base + '/v1/ask', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RELAY_VOICE_TOKEN || ''}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: arg, wait_seconds: Number(flag('--wait') ?? 25) }),
  });
  print({ http: res.status, ...(await res.json().catch(() => ({}))) });
} else if (cmd === 'get' && arg) {
  const r = await call('GET', `/v1/requests/${arg}`);
  print({ http: r.status, ...r.json });
} else {
  process.stderr.write('usage: cli.ts send <template> [--key uuid] [--wait] | ask <text> [--wait s] | get <request_id> | health\n');
  process.exit(2);
}
