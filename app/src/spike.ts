// P1-01 device spike (docs/p1/P1-design.md §8, docs/p1/device-test-plan.md S1–S5).
// Observation only: no token, nothing posted to Discord, audio kept in memory and discarded.
//   S1  Korean glyphs in a Hub text container          → look at line 1 on the lens
//   S2  WebView → relay over Tailscale Serve (healthz)  → "서버" line; relay log shows origin/ts_login
//   S3  G2 microphone PCM                               → "마이크" line (bytes, seconds, level)
//   S4  lock / background                               → "멈춤" line (timer gaps), 앞/뒤 events
//   S5  R1 / temple input events                        → "입력" line (event type + source)
import {
  AudioInputSource,
  CreateStartUpPageContainer,
  EventSourceType,
  OsEventTypeList,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import type { EvenAppBridge, EvenHubEvent } from '@evenrealities/even_hub_sdk';

const RELAY = import.meta.env.VITE_RELAY_ORIGIN as string; // app/.env.local (untracked); vite.config.ts refuses to run without it
const VERSION = 'spike 0.1';
const RECORD_MS = 5000;
const SAMPLE_RATE = 16000; // PCM s16le mono (SDK docs)

const $ = (id: string) => document.getElementById(id)!;
const phoneLog: string[] = [];
function log(msg: string): void {
  const line = `${new Date().toLocaleTimeString('ko-KR', { hour12: false })} ${msg}`;
  phoneLog.unshift(line);
  phoneLog.length = Math.min(phoneLog.length, 200);
  $('log').textContent = phoneLog.join('\n');
  console.log('[spike]', line);
}

// ---- state shown on the lens ------------------------------------------------
const state = {
  server: '확인 전',
  mic: '누르면 5초 녹음',
  inputs: [] as string[],
  started: Date.now(),
  lastTick: Date.now(),
  maxGapS: 0,
  gaps: 0,
  fg: '',
};

function lensText(): string {
  const up = Math.round((Date.now() - state.started) / 1000);
  return [
    `G2 시험 ${VERSION} · 다람쥐 헌 쳇바퀴에 타고파`,
    `서버: ${state.server}`,
    `마이크: ${state.mic}`,
    `입력: ${state.inputs.slice(0, 4).join(' ') || '-'}`,
    `경과 ${up}s · 멈춤 ${state.gaps}회 최대 ${state.maxGapS}s ${state.fg}`,
    '누르기=녹음 · 두 번=서버 확인',
  ].join('\n');
}

let bridge: EvenAppBridge | null = null;
let pageReady = false;
let renderQueued = false;
function render(): void {
  $('glasses').textContent = lensText();
  if (!bridge || !pageReady || renderQueued) return;
  renderQueued = true;
  // Coalesce updates; BLE text updates are not free.
  setTimeout(() => {
    renderQueued = false;
    void bridge!
      .textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'main', content: lensText() }))
      .catch((e: unknown) => log(`textContainerUpgrade 오류 ${String(e)}`));
  }, 300);
}

// ---- S2: relay reachability ---------------------------------------------------
async function ping(): Promise<void> {
  state.server = '확인 중…';
  render();
  const t0 = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(`${RELAY}/healthz`, { cache: 'no-store', signal: ctl.signal });
    const body = (await res.json()) as { ready?: boolean; connected?: boolean };
    const ms = Math.round(performance.now() - t0);
    state.server = `OK ${res.status} ${ms}ms ready=${body.ready ? 'Y' : 'N'}`;
    log(`healthz ${res.status} ${ms}ms ${JSON.stringify(body)} origin=${location.origin}`);
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    state.server = `실패 ${ms}ms ${(e as Error).name}`;
    log(`healthz 실패 ${ms}ms ${String(e)} origin=${location.origin}`);
  } finally {
    clearTimeout(timer);
    render();
  }
}

// ---- S3: glasses microphone ---------------------------------------------------
let recording = false;
let pcmBytes = 0;
let frames = 0;
let sumSq = 0;
let samples = 0;
let peak = 0;
const sources = new Set<string>();

function onAudio(pcm: Uint8Array, source: string): void {
  if (!recording) return;
  frames++;
  pcmBytes += pcm.length;
  sources.add(source);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const s = view.getInt16(i, true);
    sumSq += s * s;
    samples++;
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
}

async function record(): Promise<void> {
  if (!bridge || recording) return;
  recording = true;
  pcmBytes = frames = sumSq = samples = peak = 0;
  sources.clear();
  state.mic = '● 녹음 중 (말해 보세요)';
  render();
  const t0 = performance.now();
  let opened = false;
  try {
    opened = await bridge.audioControl(true, AudioInputSource.Glasses);
    log(`audioControl(true, glasses) → ${opened}`);
    if (!opened) {
      state.mic = '마이크 열기 실패 (false)';
      return;
    }
    await new Promise((r) => setTimeout(r, RECORD_MS));
  } catch (e) {
    state.mic = `마이크 오류 ${(e as Error).name}`;
    log(`audioControl 오류 ${String(e)}`);
  } finally {
    if (opened) await bridge.audioControl(false).catch(() => false);
    recording = false;
    const wall = (performance.now() - t0) / 1000;
    const audioS = pcmBytes / 2 / SAMPLE_RATE;
    const rms = samples ? Math.round(Math.sqrt(sumSq / samples)) : 0;
    if (opened) {
      state.mic = `${audioS.toFixed(1)}s/${wall.toFixed(1)}s ${frames}프레임 rms ${rms} 최대 ${peak}`;
      log(`녹음 끝: ${pcmBytes}B ${frames} frames audio=${audioS.toFixed(2)}s wall=${wall.toFixed(2)}s rms=${rms} peak=${peak} sources=${[...sources].join(',')}`);
    }
    render();
  }
}

// ---- S5 / S4: input and lifecycle events -----------------------------------------
const TYPE: Record<number, string> = {
  [OsEventTypeList.CLICK_EVENT]: '누름',
  [OsEventTypeList.DOUBLE_CLICK_EVENT]: '두번',
  [OsEventTypeList.SCROLL_TOP_EVENT]: '위',
  [OsEventTypeList.SCROLL_BOTTOM_EVENT]: '아래',
  [OsEventTypeList.LONG_PRESS_EVENT]: '길게',
  [OsEventTypeList.LONG_PRESS_RELEASE_EVENT]: '뗌',
  [OsEventTypeList.FOREGROUND_ENTER_EVENT]: '앞',
  [OsEventTypeList.FOREGROUND_EXIT_EVENT]: '뒤',
  [OsEventTypeList.ABNORMAL_EXIT_EVENT]: '비정상종료',
  [OsEventTypeList.SYSTEM_EXIT_EVENT]: '시스템종료',
};
const SOURCE: Record<number, string> = {
  [EventSourceType.TOUCH_EVENT_FROM_GLASSES_R]: 'R',
  [EventSourceType.TOUCH_EVENT_FROM_GLASSES_L]: 'L',
  [EventSourceType.TOUCH_EVENT_FROM_RING]: '링',
};

function onHubEvent(ev: EvenHubEvent): void {
  if (ev.audioEvent) {
    onAudio(ev.audioEvent.audioPcm, String(ev.audioEvent.source));
    return;
  }
  const sys = ev.sysEvent;
  const txt = ev.textEvent;
  if (!sys && !txt && !ev.listEvent && !ev.menuItemClickEvent) return;
  if (sys?.eventType === OsEventTypeList.IMU_DATA_REPORT) return;
  // Protobuf omits 0, so a click can arrive with eventType undefined.
  const rawType = sys?.eventType ?? txt?.eventType ?? ev.listEvent?.eventType;
  const type = rawType ?? OsEventTypeList.CLICK_EVENT;
  const src = sys?.eventSource !== undefined ? (SOURCE[sys.eventSource] ?? `src${sys.eventSource}`) : txt ? '텍스트' : '?';
  const label = `${TYPE[type] ?? `t${type}`}${rawType === undefined ? '*' : ''}(${src})`;
  state.inputs.unshift(label);
  state.inputs.length = Math.min(state.inputs.length, 8);
  log(`event ${label} raw=${JSON.stringify(ev.jsonData ?? {}).slice(0, 300)}`);

  switch (type) {
    case OsEventTypeList.CLICK_EVENT:
      void record();
      break;
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      void ping();
      break;
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
      state.fg = '· 앞';
      void ping();
      break;
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      state.fg = '· 뒤';
      break;
  }
  render();
}

// Timer gaps reveal whether the WebView was paused (lock screen, background).
setInterval(() => {
  const now = Date.now();
  const gap = now - state.lastTick;
  state.lastTick = now;
  if (gap > 3000) {
    state.gaps++;
    state.maxGapS = Math.max(state.maxGapS, Math.round(gap / 1000));
    log(`타이머 멈춤 ${Math.round(gap / 1000)}s`);
  }
  render();
}, 1000);

document.addEventListener('visibilitychange', () => log(`visibility ${document.visibilityState}`));
$('rec').addEventListener('click', () => void record());
$('ping').addEventListener('click', () => void ping());

async function main(): Promise<void> {
  log(`시작 ${VERSION} origin=${location.origin} relay=${RELAY}`);
  render();
  bridge = await waitForEvenAppBridge();
  bridge.onLaunchSource((s) => log(`launch source ${s}`));
  bridge.onEvenHubEvent(onHubEvent);
  const dev = await bridge.getDeviceInfo().catch(() => null);
  log(`device ${JSON.stringify(dev ?? null).slice(0, 200)}`);
  const result = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [
        new TextContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: 576,
          height: 288,
          containerID: 1,
          containerName: 'main',
          content: lensText(),
          isEventCapture: 1,
        }),
      ],
    }),
  );
  log(`createStartUpPageContainer → ${result}`);
  pageReady = result === StartUpPageCreateResult.success;
  render();
  void ping();
}

main().catch((e) => log(`main 오류 ${String(e)}`));
