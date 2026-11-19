// P1-05 G2 voice app for Chris (docs/p1/P1-design.md §5).
//   pairing → idle → listening → transcribing → confirm → awaiting → reply → idle   (+ error)
// The relay is the source of truth: only the device token and the last request ID are kept on the phone.
// Audio stays in memory until it is posted to the Mac relay for whisper, then it is dropped.
import {
  AudioInputSource,
  CreateStartUpPageContainer,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import type { EvenAppBridge, EvenHubEvent } from '@evenrealities/even_hub_sdk';
import { RELAY, RelayError, api, uuid } from './api.ts';
import type { AskView } from './api.ts';
import { paginate } from './paginate.ts';

const VERSION = '0.3.0';
const MAX_RECORD_MS = 30_000;
const MAX_PCM_BYTES = 960_000;
const PAGE_CHARS = 180; // tune on hardware (P1-06)
const K_TOKEN = 'g2relay.deviceToken';
const K_LAST = 'g2relay.lastRequestId';

// ---- phone-side log (Even app page; never sent anywhere) -------------------------------------
const $ = (id: string) => document.getElementById(id)!;
const phoneLog: string[] = [];
function log(msg: string): void {
  phoneLog.unshift(`${new Date().toLocaleTimeString('ko-KR', { hour12: false })} ${msg}`);
  phoneLog.length = Math.min(phoneLog.length, 200);
  $('log').textContent = phoneLog.join('\n');
  console.log('[g2relay]', msg);
}

// ---- state ----------------------------------------------------------------------------------
type State =
  | { k: 'boot' }
  | { k: 'pairing'; code: string; pairingId: string; secret: string; expiresAt: number; note: string }
  | { k: 'idle'; note: string }
  | { k: 'listening'; startedAt: number; hearing: boolean }
  | { k: 'transcribing' }
  | { k: 'confirm'; transcriptId: string; text: string }
  | { k: 'awaiting'; requestId: string; since: number; note: string }
  | { k: 'reply'; requestId: string; pages: string[]; page: number; late: boolean }
  | { k: 'error'; message: string };

let st: State = { k: 'boot' };
let bridge: EvenAppBridge | null = null;
let token = '';
let pageReady = false;
let gen = 0; // bumps on every state change; async loops stop when it moves on

function set(next: State): void {
  st = next;
  gen++;
  render();
}

function lensText(): string {
  const sec = (t: number) => Math.max(0, Math.floor((Date.now() - t) / 1000));
  switch (st.k) {
    case 'boot':
      return 'Chris\n\n시작하는 중…';
    case 'pairing':
      return ['Chris · 기기 등록', '', `등록 번호  ${st.code.slice(0, 3)} ${st.code.slice(3)}`, '', 'Mac에서:  npm run admin -- pair ' + st.code, st.note || `${Math.max(0, Math.round((st.expiresAt - Date.now()) / 1000))}초 안에 승인`, '두 번 = 새 번호'].join('\n');
    case 'idle':
      return ['Chris', '', '누르기 = 말하기', '위로 쓸기 = 지난 답 보기', '', st.note].join('\n');
    case 'listening':
      return ['Chris', '', st.hearing ? `● 듣는 중…  ${sec(st.startedAt)}초` : '마이크 준비 중…', '', '누르기 = 끝 · 두 번 = 취소', `(최대 ${MAX_RECORD_MS / 1000}초)`].join('\n');
    case 'transcribing':
      return 'Chris\n\n인식 중…';
    case 'confirm': {
      const t = [...st.text].length > 150 ? [...st.text].slice(0, 150).join('') + '…' : st.text;
      return ['보낼까요?', '', `“${t}”`, '', '누르기 = 전송 · 두 번 = 취소'].join('\n');
    }
    case 'awaiting':
      return ['Chris', '', `전송됨 · 답 기다리는 중 ${sec(st.since)}초`, st.note, '', '두 번 = 화면 닫기 (답은 위로 쓸기로 다시 보기)'].join('\n');
    case 'reply': {
      const n = st.pages.length;
      const head = `Chris 답${n > 1 ? ` ${st.page + 1}/${n}` : ''}${st.late ? ' (늦은 답)' : ''}`;
      const foot = n > 1 ? '위·아래 = 넘기기 · 누르기 = 닫기' : '누르기 = 닫기';
      return [head, st.pages[st.page] ?? '', '', foot].join('\n');
    }
    case 'error':
      return ['Chris', '', st.message, '', '누르기 = 처음 화면'].join('\n');
  }
}

let renderQueued = false;
// P1-04 displayed: report once the first reply page is actually on the lens (after textContainerUpgrade).
// Speech end = the press that stopped recording, on the phone clock; carried to the request it produced.
let speechEndAt: number | null = null;
const speechEndByRequest = new Map<string, number>();
let pendingDisplayed: string | null = null;

function reportDisplayed(): void {
  const id = pendingDisplayed;
  if (!id || st.k !== 'reply' || st.requestId !== id || st.page !== 0) return;
  pendingDisplayed = null;
  const t0 = speechEndByRequest.get(id);
  speechEndByRequest.delete(id);
  const since = t0 !== undefined ? Math.max(0, Math.round(Date.now() - t0)) : undefined;
  api
    .displayed(token, id, since !== undefined && since <= 3_600_000 ? since : undefined)
    .then(({ data }) => log(`표시 기록 ${data.recorded ? '저장' : '이미 있음'}${since !== undefined ? ` 말 끝→표시 ${(since / 1000).toFixed(1)}s` : ''}`))
    .catch((e: unknown) => log(`표시 기록 실패 ${e instanceof RelayError ? e.code : String(e)}`));
}

function render(): void {
  const text = lensText();
  $('glasses').textContent = text;
  if (!bridge || !pageReady || renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    void bridge!
      .textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'main', content: lensText() }))
      .then((ok) => {
        if (ok !== false) reportDisplayed();
      })
      .catch((e: unknown) => log(`화면 갱신 오류 ${String(e)}`));
  }, 150);
}
// Second counters (listening / awaiting / pairing).
setInterval(() => {
  if (st.k === 'listening' || st.k === 'awaiting' || st.k === 'pairing') render();
  if (st.k === 'listening' && Date.now() - st.startedAt >= MAX_RECORD_MS) void stopListening();
  if (st.k === 'pairing' && Date.now() > st.expiresAt) void startPairing('번호 만료 — 새 번호');
}, 1000);

function errorText(e: unknown): string {
  const code = e instanceof RelayError ? e.code : 'unknown';
  const m: Record<string, string> = {
    network: '연결 안 됨 — iPhone Tailscale 확인',
    timeout: '응답 없음 — Mac·Tailscale 확인',
    tailnet_identity_required: 'Tailscale 로그인 확인',
    channel_busy: '이전 질문의 답을 기다리는 중',
    stt_busy: '다른 인식 처리 중 — 잠시 후',
    stt_unavailable: 'Mac 음성 인식을 쓸 수 없음',
    stt_failed: '음성 인식 실패 — 다시 말해 주세요',
    relay_not_ready: '중계가 Discord에 연결 안 됨',
    rate_limited: '너무 잦음 — 잠시 후',
    transcript_expired: '시간이 지남 — 다시 말해 주세요',
    audio_too_short: '너무 짧음 — 다시 말해 주세요',
    too_many_pairings: '등록 대기 너무 많음 — 5분 후',
  };
  return m[code] ?? `오류 (${code})`;
}

/** 401/403 on a device call → token gone or revoked → back to pairing. */
async function handleAuthError(e: unknown): Promise<boolean> {
  if (e instanceof RelayError && (e.code === 'unauthenticated' || e.code === 'device_revoked')) {
    token = '';
    await bridge?.setLocalStorage(K_TOKEN, '');
    log(`기기 인증 끊김 (${e.code}) → 다시 등록`);
    void startPairing(e.code === 'device_revoked' ? '이 기기 등록이 취소됨 — 다시 등록' : '');
    return true;
  }
  return false;
}

// ---- pairing (P1-02) ---------------------------------------------------------------------------
async function startPairing(note = ''): Promise<void> {
  try {
    const { data } = await api.pairingStart();
    set({ k: 'pairing', code: data.code, pairingId: data.pairing_id, secret: data.claim_secret, expiresAt: Date.parse(data.expires_at), note });
    log(`등록 번호 발급 ${data.code}`);
    void pollClaim(gen);
  } catch (e) {
    set({ k: 'error', message: `등록 시작 실패: ${errorText(e)}` });
  }
}

async function pollClaim(myGen: number): Promise<void> {
  while (gen === myGen && st.k === 'pairing') {
    await new Promise((r) => setTimeout(r, 2000));
    if (gen !== myGen || st.k !== 'pairing') return;
    try {
      const { data } = await api.pairingClaim(st.pairingId, st.secret);
      if (data.status === 'approved' && data.device_token) {
        token = data.device_token;
        await bridge?.setLocalStorage(K_TOKEN, token);
        log(`등록 완료 (기기 ${data.device_id})`);
        set({ k: 'idle', note: '등록 완료' });
        return;
      }
    } catch (e) {
      if (gen !== myGen) return;
      if (e instanceof RelayError && (e.code === 'pairing_expired' || e.code === 'not_found' || e.code === 'already_claimed')) return void startPairing('번호 만료 — 새 번호');
      log(`등록 확인 오류 ${(e as RelayError).code ?? e}`);
    }
  }
}

// ---- listening (G2 microphone) -----------------------------------------------------------------
let chunks: Uint8Array[] = [];
let pcmBytes = 0;

async function startListening(): Promise<void> {
  if (!bridge) return;
  chunks = [];
  pcmBytes = 0;
  set({ k: 'listening', startedAt: Date.now(), hearing: false });
  const myGen = gen;
  try {
    const ok = await bridge.audioControl(true, AudioInputSource.Glasses);
    log(`마이크 열기 → ${ok}`);
    if (!ok && gen === myGen) set({ k: 'error', message: '안경 마이크를 열 수 없음' });
  } catch (e) {
    log(`마이크 오류 ${String(e)}`);
    if (gen === myGen) set({ k: 'error', message: '안경 마이크 오류' });
  }
}

function onAudio(pcm: Uint8Array): void {
  if (st.k !== 'listening') return;
  if (!st.hearing) {
    // The first ~0.5 s after opening is lost (P1-01 S3); "듣는 중" only once audio really flows.
    st.hearing = true;
    st.startedAt = Date.now();
    render();
  }
  if (pcmBytes + pcm.length > MAX_PCM_BYTES) return void stopListening();
  chunks.push(pcm.slice());
  pcmBytes += pcm.length;
}

async function closeMic(): Promise<void> {
  await bridge?.audioControl(false).catch(() => false);
}

async function cancelListening(): Promise<void> {
  await closeMic();
  chunks = [];
  pcmBytes = 0;
  set({ k: 'idle', note: '취소함' });
}

async function stopListening(): Promise<void> {
  if (st.k !== 'listening') return;
  speechEndAt = Date.now();
  set({ k: 'transcribing' });
  const myGen = gen;
  await closeMic();
  const pcm = new Uint8Array(pcmBytes - (pcmBytes % 2));
  let off = 0;
  for (const c of chunks) {
    const n = Math.min(c.length, pcm.length - off);
    pcm.set(c.subarray(0, n), off);
    off += n;
  }
  chunks = [];
  pcmBytes = 0;
  log(`녹음 ${(pcm.length / 32000).toFixed(1)}초 → 인식 요청`);
  try {
    const { data } = await api.transcribe(token, pcm);
    if (gen !== myGen) return;
    log(`인식 ${data.stt_ms}ms rms ${data.max_rms} ${data.no_speech ? '말 없음' : `${[...data.text].length}자`}`);
    if (data.no_speech || !data.transcript_id) return set({ k: 'idle', note: '말씀을 듣지 못했습니다' });
    set({ k: 'confirm', transcriptId: data.transcript_id, text: data.text });
  } catch (e) {
    if (gen !== myGen || (await handleAuthError(e))) return;
    set({ k: 'error', message: errorText(e) });
  }
}

// ---- send and wait -----------------------------------------------------------------------------
async function send(): Promise<void> {
  if (st.k !== 'confirm') return;
  const { transcriptId } = st;
  const key = uuid();
  set({ k: 'awaiting', requestId: '', since: Date.now(), note: '' });
  const myGen = gen;
  try {
    const { data } = await api.ask(token, transcriptId, key);
    if (gen !== myGen) return;
    await bridge?.setLocalStorage(K_LAST, data.request_id);
    log(`전송 ${data.request_id.slice(0, 8)} ${data.status}`);
    const cur = st as State; // st changed via set() above; TS keeps the old narrowing
    if (cur.k === 'awaiting') cur.requestId = data.request_id;
    if (speechEndAt !== null) speechEndByRequest.set(data.request_id, speechEndAt);
    speechEndAt = null;
    if (data.done) return showReply(data);
    void poll(myGen, data.request_id);
  } catch (e) {
    if (gen !== myGen || (await handleAuthError(e))) return;
    set({ k: 'error', message: errorText(e) });
  }
}

async function poll(myGen: number, id: string): Promise<void> {
  let failures = 0;
  while (gen === myGen && st.k === 'awaiting') {
    try {
      const { data } = await api.askGet(token, id, 25);
      if (gen !== myGen) return;
      failures = 0;
      if (st.k === 'awaiting' && st.note) {
        st.note = '';
        render();
      }
      if (data.done) return showReply(data);
    } catch (e) {
      if (gen !== myGen || (await handleAuthError(e))) return;
      failures++;
      if (st.k === 'awaiting') {
        st.note = `연결 재시도 ${failures}회`;
        render();
      }
      await new Promise((r) => setTimeout(r, Math.min(15_000, 2000 * failures)));
    }
  }
}

function showReply(v: AskView): void {
  log(`답 ${v.status} ${v.reply_available ? `${[...v.reply].length}자` : '(본문 없음)'}`);
  if (v.reply_available) pendingDisplayed = v.request_id;
  set({ k: 'reply', requestId: v.request_id, pages: paginate(v.reply, PAGE_CHARS), page: 0, late: v.late_reply });
}

async function showLast(): Promise<void> {
  const id = await bridge?.getLocalStorage(K_LAST).catch(() => '');
  if (!id) return set({ k: 'idle', note: '지난 질문 없음' });
  try {
    const { data } = await api.askGet(token, id, 0);
    if (!data.done) {
      set({ k: 'awaiting', requestId: id, since: Date.now(), note: '이전 질문 답 기다리는 중' });
      return void poll(gen, id);
    }
    showReply(data);
  } catch (e) {
    if (await handleAuthError(e)) return;
    set({ k: 'idle', note: e instanceof RelayError && e.code === 'not_found' ? '지난 답이 서버에 없음' : errorText(e) });
  }
}

// ---- input -------------------------------------------------------------------------------------
type Input = 'click' | 'double' | 'up' | 'down';

function onInput(i: Input): void {
  log(`입력 ${i} @${st.k}`);
  switch (st.k) {
    case 'pairing':
      if (i === 'double') void startPairing();
      return;
    case 'idle':
      if (i === 'click') void startListening();
      else if (i === 'up') void showLast();
      return;
    case 'listening':
      if (i === 'click') void stopListening();
      else if (i === 'double') void cancelListening();
      return;
    case 'confirm':
      if (i === 'click') void send();
      else if (i === 'double') set({ k: 'idle', note: '보내지 않음' });
      return;
    case 'awaiting':
      if (i === 'double') set({ k: 'idle', note: '답은 위로 쓸기로 다시 보기' });
      return;
    case 'reply':
      if (i === 'click' || (i === 'double' && st.pages.length === 1)) set({ k: 'idle', note: '' });
      else if (i === 'down' && st.page < st.pages.length - 1) {
        st.page++;
        render();
      } else if (i === 'up' && st.page > 0) {
        st.page--;
        render();
      }
      return;
    case 'error':
      if (i !== 'click') return;
      if (token) set({ k: 'idle', note: '' });
      else void startPairing();
      return;
    default:
      return;
  }
}

function onHubEvent(ev: EvenHubEvent): void {
  if (ev.audioEvent) return onAudio(ev.audioEvent.audioPcm);
  const sys = ev.sysEvent;
  const txt = ev.textEvent;
  if (!sys && !txt && !ev.listEvent) return;
  // Protobuf omits 0, so CLICK (0) can arrive with eventType undefined.
  const t = sys?.eventType ?? txt?.eventType ?? ev.listEvent?.eventType ?? OsEventTypeList.CLICK_EVENT;
  switch (t) {
    case OsEventTypeList.CLICK_EVENT:
      return onInput('click');
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      return onInput('double');
    case OsEventTypeList.SCROLL_TOP_EVENT:
      return onInput('up');
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      return onInput('down');
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      log('앱 뒤로');
      if (st.k === 'listening') void cancelListening();
      return;
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
      log('앱 앞으로');
      // Resume a wait that may have been cut while away; the relay kept the request going.
      if (st.k === 'awaiting' && st.requestId) {
        gen++;
        void poll(gen, st.requestId);
      }
      return;
    default:
      return;
  }
}

// Phone page buttons mirror the glasses inputs (handy in the simulator and for checking on the phone).
for (const [id, i] of [['b-click', 'click'], ['b-double', 'double'], ['b-up', 'up'], ['b-down', 'down']] as const) {
  $(id).addEventListener('click', () => onInput(i));
}
$('b-unpair').addEventListener('click', async () => {
  token = '';
  await bridge?.setLocalStorage(K_TOKEN, '');
  log('이 휴대폰의 기기 토큰을 지움 (서버 쪽 폐기는 Mac에서 admin revoke-device)');
  void startPairing();
});

async function main(): Promise<void> {
  log(`시작 ${VERSION} relay=${RELAY}`);
  render();
  bridge = await waitForEvenAppBridge();
  bridge.onEvenHubEvent(onHubEvent);
  const page = () => ({
    containerTotalNum: 1,
    textObject: [new TextContainerProperty({ xPosition: 0, yPosition: 0, width: 576, height: 288, containerID: 1, containerName: 'main', content: lensText(), isEventCapture: 1 })],
  });
  const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page()));
  pageReady = result === StartUpPageCreateResult.success;
  // A WebView reload (dev server, re-scan) finds the startup page already there → "invalid"; rebuild it instead.
  if (result === StartUpPageCreateResult.invalid) pageReady = await bridge.rebuildPageContainer(new RebuildPageContainer(page())).catch(() => false);
  log(`화면 생성 → ${result}${result === StartUpPageCreateResult.invalid ? ` (다시 만들기 ${pageReady})` : ''}`);
  token = (await bridge.getLocalStorage(K_TOKEN).catch(() => '')) || '';
  if (!token) return void startPairing();
  set({ k: 'idle', note: '' });
}

main().catch((e) => log(`시작 오류 ${String(e)}`));
