// Sequential live runner for AT-16: sends N requests one at a time, waits for each to reach a
// terminal state, appends one JSON line per run. Never sends the next request until the
// previous one is terminal (FR-07). Stops early on any non-completed result.
//   RELAY_URL=... RELAY_CLIENT_TOKEN=... node scripts/live-sequential.ts <count> <template> <out.jsonl> [gapMs]
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const [countArg, template, outPath, gapArg] = process.argv.slice(2);
const count = Number(countArg);
const gap = Number(gapArg ?? 3000);
const base = process.env.RELAY_URL!;
const auth = { authorization: `Bearer ${process.env.RELAY_CLIENT_TOKEN}` };
const TERMINAL = new Set(['completed', 'failed', 'timed_out', 'ambiguous_response', 'delivery_unknown']);
if (!count || !template || !outPath || !base) throw new Error('usage: <count> <template> <out.jsonl> [gapMs]');

for (let i = 1; i <= count; i++) {
  const key = randomUUID();
  const post = await fetch(`${base}/v1/requests`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ target: 'chris-primary', template, arguments: {} }),
  });
  const pj = (await post.json()) as { request_id?: string; error_code?: string };
  if (post.status !== 202 || !pj.request_id) {
    appendFileSync(outPath, JSON.stringify({ run: i, http: post.status, error_code: pj.error_code }) + '\n');
    process.stderr.write(`run ${i}: POST ${post.status} ${pj.error_code}\n`);
    break;
  }
  let view: any;
  // Relay timeout is 120 s; poll a little longer than that.
  for (let t = 0; t < 140; t++) {
    await new Promise((r) => setTimeout(r, 1000));
    view = await (await fetch(`${base}/v1/requests/${pj.request_id}`, { headers: auth })).json();
    if (TERMINAL.has(view.status)) break;
  }
  appendFileSync(outPath, JSON.stringify({ run: i, idempotency_key: key, ...view }) + '\n');
  process.stderr.write(`run ${i}: ${view.status}\n`);
  if (view.status !== 'completed') break;
  if (i < count) await new Promise((r) => setTimeout(r, gap));
}
