// P1-05 app pure helpers (the app itself is checked in the simulator and on the glasses).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { paginate } from '../app/src/paginate.ts';

describe('P1-05 reply pagination', () => {
  it('keeps short replies on one page', () => {
    assert.deepEqual(paginate('세미나는 3시입니다.', 180), ['세미나는 3시입니다.']);
    assert.deepEqual(paginate('', 180), ['']);
  });
  it('breaks on lines, then spaces, never exceeding the page size', () => {
    const para = '가나다라 마바사 아자차카 타파하. '.repeat(20).trim();
    const text = `첫 줄\n${para}\n끝 줄`;
    const pages = paginate(text, 60);
    for (const p of pages) assert.ok([...p].length <= 60, `${[...p].length}: ${p}`);
    assert.equal(pages.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
    assert.equal(pages[0], '첫 줄');
  });
  it('splits a single overlong word', () => {
    const pages = paginate('가'.repeat(130), 60);
    assert.deepEqual(pages.map((p) => [...p].length), [60, 60, 10]);
  });
});

describe('P1 installed app origin (http://127.0.0.1:<port per launch>)', () => {
  it('matches loopback any port only when configured, nothing else', async () => {
    const { originAllowed, LOOPBACK_ANY_PORT } = await import('../src/api/server.ts');
    const allowed = ['http://100.64.0.1:5173', LOOPBACK_ANY_PORT];
    assert.ok(originAllowed(allowed, 'http://100.64.0.1:5173'));
    assert.ok(originAllowed(allowed, 'http://127.0.0.1:65024'));
    assert.ok(!originAllowed(['http://100.64.0.1:5173'], 'http://127.0.0.1:65024'));
    for (const o of ['http://127.0.0.1', 'https://127.0.0.1:65024', 'http://127.0.0.1:65024.evil.example', 'http://localhost:65024', 'http://127.0.0.2:65024', 'null'])
      assert.ok(!originAllowed(allowed, o), o);
  });

  it('config accepts only that one wildcard', async () => {
    const { ConfigError, loadConfig } = await import('../src/config.ts');
    const { TOKEN } = await import('./helpers.ts');
    const base = { RELAY_MODE: 'mock', RELAY_CLIENT_TOKEN: TOKEN, RELAY_PRINCIPAL_ID: 'owner' };
    assert.deepEqual(loadConfig({ ...base, RELAY_ALLOWED_ORIGIN: 'http://a.example:5173,http://127.0.0.1:*' }).allowedOrigins, ['http://a.example:5173', 'http://127.0.0.1:*']);
    for (const bad of ['*', 'http://*:5173', 'http://localhost:*', 'https://*.example', 'null'])
      assert.throws(() => loadConfig({ ...base, RELAY_ALLOWED_ORIGIN: bad }), ConfigError, bad);
  });
});

describe('P1-03 silence cutoff calibration (admin rms)', async () => {
  const { parseSttLog, suggestCutoff, parseMinRms } = await import('../src/calibrate.ts');
  const line = (rms: number, chars: number, noSpeech = false) =>
    JSON.stringify({ ts: '2026-11-20T01:00:00.000Z', level: 'info', event: 'stt', audio_ms: 5000, max_rms: rms, model: 'small', no_speech: noSpeech, stt_ms: 900, chars, device_id: 'x' });
  const e = (rms: number, chars: number, noSpeech = false) => parseSttLog(line(rms, chars, noSpeech))[0]!;

  it('parses only stt lines and ignores junk', () => {
    const log = [line(120, 0, true), '{"event":"http","status":200}', 'not json "event":"stt"', line(6084, 48)].join('\n');
    assert.deepEqual(parseSttLog(log).map((x) => [x.maxRms, x.noSpeech, x.chars]), [[120, true, 0], [6084, false, 48]]);
  });

  it('puts the cutoff between the loudest silence and the quietest speech', () => {
    // 923 = a silent recording whisper found empty (above the old 500 gate): must stay on the silence side.
    assert.equal(suggestCutoff([e(109, 0, true), e(923, 0, true), e(2000, 12), e(6084, 48)]).cutoff, 1360); // sqrt(923*2000) ≈ 1359
  });

  it('a hallucinated silence (text, low rms) only lowers the suggestion', () => {
    assert.equal(suggestCutoff([e(300, 0, true), e(700, 6), e(6000, 40)]).cutoff, 460); // sqrt(300*700) ≈ 458
  });

  it('refuses without both kinds of recording or without a 2x gap', () => {
    assert.equal(suggestCutoff([e(6000, 20), e(8000, 30)]).cutoff, null);
    assert.equal(suggestCutoff([e(120, 0, true)]).cutoff, null);
    assert.equal(suggestCutoff([e(900, 0, true), e(1500, 15), e(8000, 30)]).cutoff, null);
    assert.equal(suggestCutoff([e(0, 0, true), e(6000, 20)]).cutoff, null); // rms 0 = synthetic silence, ignored
  });

  it('accepts only integers in range', () => {
    assert.equal(parseMinRms('800\n'), 800);
    for (const bad of [undefined, '', '49', '30001', '8e2', '-5', '800x']) assert.equal(parseMinRms(bad), null, String(bad));
  });
});
