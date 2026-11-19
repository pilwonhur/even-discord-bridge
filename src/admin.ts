// Operator tool (local DB access; no network, no Discord posts).
//   node src/admin.ts list [n]                 recent requests (metadata only)
//   node src/admin.ts show <request_id>        timeline + parts metadata
//   node src/admin.ts resolve-failed <id>      delivery_unknown/accepted → failed (releases the channel lock)
//   node src/admin.ts confirm-posted <id> <discord_message_id>   delivery_unknown → awaiting_reply after manual check
//   node src/admin.ts purge                    apply retention now
//   node src/admin.ts pair <6-digit code>      approve the G2 app pairing whose code is on the glasses (P1-02)
//   node src/admin.ts devices                  paired devices (no tokens)
//   node src/admin.ts revoke-device <id>       cut a paired device off immediately
//   node src/admin.ts rms [n]                  loudness of the last n recordings (default 20) + suggested silence cutoff
//   node src/admin.ts set-rms <50..30000>      save the silence cutoff (data/stt-min-rms.txt) and restart the relay
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_MIN_RMS, MIN_RMS_CEIL, MIN_RMS_FLOOR, parseMinRms, parseSttLog, suggestCutoff } from './calibrate.ts';
import { Store } from './store/store.ts';

const dbPath = process.env.RELAY_DB_PATH || './data/relay.sqlite';
const store = new Store(dbPath);
const [cmd, a, b] = process.argv.slice(2);
const now = Date.now();
const out = (x: unknown) => process.stdout.write(JSON.stringify(x, null, 2) + '\n');
const logPath = process.env.RELAY_LOG_PATH || './data/relay-live.log';
const rmsFile = './data/stt-min-rms.txt';
const savedRms = () => (existsSync(rmsFile) ? parseMinRms(readFileSync(rmsFile, 'utf8')) : null);
/** stt_min_rms from the most recent relay start ("listening" line), i.e. what the running relay uses. */
const runningRms = (log: string): number | null => {
  const lines = log.split('\n').filter((l) => l.includes('"event":"listening"'));
  const m = lines.at(-1)?.match(/"stt_min_rms":(\d+)/);
  return m ? Number(m[1]) : null;
};

try {
  if (cmd === 'list') {
    out(
      store.listRecent(Number(a) || 20).map((r) => ({
        id: r.id,
        status: r.status,
        template: r.template,
        created_at: new Date(r.created_at).toISOString(),
        discord_message_id: r.discord_message_id,
        error_code: r.error_code,
      })),
    );
  } else if (cmd === 'show' && a) {
    const r = store.get(a);
    if (!r) throw new Error('not found');
    const { rendered_text: _t, ...meta } = r;
    out({
      request: meta,
      timeline: store.events(a).map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
      parts: store.parts(a).map(({ text: _x, ...p }) => p),
    });
  } else if (cmd === 'resolve-failed' && a) {
    const ok = store.transition(a, ['delivery_unknown', 'accepted'], 'failed', now, { error_code: 'operator_marked_failed' }, 'operator');
    out({ ok, note: ok ? 'channel lock released; nothing was posted or deleted on Discord' : 'not in delivery_unknown/accepted' });
  } else if (cmd === 'confirm-posted' && a && b && /^\d{17,20}$/.test(b)) {
    const ok = store.transition(a, ['delivery_unknown'], 'awaiting_reply', now, { discord_message_id: b, sent_at: now, deadline_at: now + (Number(process.env.RELAY_REPLY_TIMEOUT_SECONDS) || 120) * 1000, error_code: null }, 'operator_confirmed_post');
    out({ ok });
  } else if (cmd === 'purge') {
    out(store.purge(now, Number(process.env.RELAY_TEXT_RETENTION_DAYS) || 7, Number(process.env.RELAY_METADATA_RETENTION_DAYS) || 30));
  } else if (cmd === 'pair' && a && /^\d{6}$/.test(a)) {
    const p = store.approvePairing(a, now);
    out(
      p
        ? { ok: true, pairing_id: p.id, note: 'approved; the glasses app picks up its device token on its next poll (within the 5-minute window)' }
        : { ok: false, note: 'no pending pairing with this code (wrong code, expired after 5 minutes, or already approved)' },
    );
    if (!p) process.exitCode = 1;
  } else if (cmd === 'devices') {
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    out(store.devices().map((d) => ({ id: d.id, principal_id: d.principal_id, created_at: iso(d.created_at), last_seen_at: iso(d.last_seen_at), revoked_at: iso(d.revoked_at) })));
  } else if (cmd === 'revoke-device' && a) {
    const ok = store.revokeDevice(a, now);
    out({ ok, note: ok ? 'revoked; takes effect on the next request' : 'no active device with this id' });
    if (!ok) process.exitCode = 1;
  } else if (cmd === 'rms') {
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    const n = Number(a) || 20;
    const revoked = new Set(store.devices().filter((d) => d.revoked_at !== null).map((d) => d.id));
    const all = parseSttLog(log);
    const entries = all.filter((e) => e.deviceId === null || !revoked.has(e.deviceId)).slice(-n);
    const skipped = all.length - all.filter((e) => e.deviceId === null || !revoked.has(e.deviceId)).length;
    const p = (s: unknown, w: number) => String(s).padStart(w);
    console.log(`최근 녹음 ${entries.length}개 (소리 크기 = rms, 문장은 기록하지 않음${skipped ? `, 폐기된 시험 기기 ${skipped}개 제외` : ''})`);
    console.log('  시각                 길이    rms  결과');
    for (const e of entries) {
      const t = new Date(e.ts).toLocaleString('sv-SE').slice(5, 16);
      console.log(`  ${t}      ${p((e.audioMs / 1000).toFixed(1) + 's', 6)} ${p(e.maxRms, 6)}  ${e.noSpeech ? '말 없음' : `인식 ${e.chars}자`}`);
    }
    const s = suggestCutoff(entries);
    const run = runningRms(log);
    console.log(`\n지금 기준: ${run ?? '알 수 없음(재시작 전 기록)'}  (저장된 값 ${savedRms() ?? `없음 → 기본 ${DEFAULT_MIN_RMS}`})`);
    console.log(`추천 기준: ${s.cutoff ?? '없음'} — ${s.reason}`);
    if (s.cutoff !== null) console.log(`바꾸려면: npm run admin -- set-rms ${s.cutoff}   (조용히 말한 녹음이 들어 있어야 믿을 만합니다)`);
  } else if (cmd === 'set-rms') {
    const v = parseMinRms(a);
    if (v === null) {
      process.stderr.write(`set-rms: ${MIN_RMS_FLOOR}..${MIN_RMS_CEIL} 사이 정수를 주세요 (예: set-rms 800)\n`);
      process.exitCode = 2;
    } else {
      const before = savedRms();
      writeFileSync(rmsFile, `${v}\n`);
      console.log(`저장: ${before ?? `기본 ${DEFAULT_MIN_RMS}`} → ${v} (${rmsFile})`);
      if (process.env.RELAY_STT_MIN_RMS) console.log('주의: RELAY_STT_MIN_RMS 환경변수가 설정돼 있으면 그 값이 우선합니다.');
      console.log('relay 재시작 중…');
      execFileSync('scripts/relay-service.sh', ['restart'], { stdio: 'ignore' });
      let seen: number | null = null;
      for (let i = 0; i < 30 && seen !== v; i++) {
        execFileSync('sleep', ['0.5']);
        seen = existsSync(logPath) ? runningRms(readFileSync(logPath, 'utf8')) : null;
      }
      console.log(seen === v ? `완료: relay가 기준 ${v}로 다시 시작했습니다.` : `확인 안 됨: relay 시작 기록에 ${v}가 보이지 않습니다. scripts/relay-service.sh status 와 data/relay-live.log를 확인하세요.`);
      if (seen !== v) process.exitCode = 1;
    }
  } else {
    process.stderr.write('usage: admin.ts list [n] | show <id> | resolve-failed <id> | confirm-posted <id> <discord_message_id> | purge | pair <code> | devices | revoke-device <id> | rms [n] | set-rms <n>\n');
    process.exitCode = 2;
  }
} finally {
  store.close();
}
