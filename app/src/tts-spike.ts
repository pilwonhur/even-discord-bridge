// T0 read-aloud spike (docs/p1/tts-design.md §2, §5). Observation only: no token, nothing posted to Discord.
//   A = iPhone built-in voice via speechSynthesis, B = Mac-made audio file (spike-assets/, made by
//   scripts/app-dev.sh start with `say`) via <audio>.
//   What it answers: is a Korean voice there, does playback start from a glasses event / a timer / a
//   network response (no phone-screen touch), does it play with the phone locked, where does the sound go,
//   and does the glasses mic still record normally after playback.
// Glasses: 누르기 = A 지금 · 두 번 = 멈춤(재생 중) 또는 B 지금 · 위로 = A 10초 뒤 · 아래로 = B 10초 뒤 · 길게 = 녹음 3초 → 바로 A
// 0.2 (AirPods vs speaker, tts-design §9): audio session type shown and logged at every start; cycle it with the
// phone button; "녹음 → A" reproduces reading right after the glasses mic was used.
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
import sampleUrl from '../spike-assets/tts-sample.m4a?url';
import { audioSession, sessionInfo } from './speech.ts';

const RELAY = import.meta.env.VITE_RELAY_ORIGIN as string;
const VERSION = 'tts-spike 0.2';
const LATER_MS = 10_000;
const REC_MS = 3000;
// Same sentence as the B file (scripts/app-dev.sh SAMPLE_TEXT), so A and B can be compared.
const SHORT = '안녕하세요, 크리스입니다. 지금은 음성 읽기 시험 중입니다. 이 문장이 들리면 아이폰에서 소리가 나오는 것입니다.';
const LONG =
  '오늘 오후 일정은 두 가지입니다. 세 시에 연구실 회의가 있고, 다섯 시까지 학회 심사 의견을 보내야 합니다. ' +
  '회의 자료는 어제 공유된 문서를 그대로 쓰면 되고, 심사 의견은 초안이 이미 있어서 결론 부분만 다듬으면 됩니다. ' +
  '저녁에는 특별한 일정이 없습니다. 내일 아침에는 아홉 시 반에 수업이 있으니 오늘 밤에 강의 자료를 한 번 확인해 두시면 좋겠습니다. ' +
  '더 필요한 것이 있으면 다시 물어봐 주세요.';

const $ = (id: string) => document.getElementById(id)!;
const phoneLog: string[] = [];
function log(msg: string): void {
  const line = `${new Date().toLocaleTimeString('ko-KR', { hour12: false })} ${msg}`;
  phoneLog.unshift(line);
  phoneLog.length = Math.min(phoneLog.length, 300);
  $('log').textContent = phoneLog.join('\n');
  console.log('[tts-spike]', line);
}
const vis = () => `${document.visibilityState}${document.hasFocus() ? '' : ',nofocus'}`;

// ---- lens ------------------------------------------------------------------------------------
const state = { voices: '확인 전', a: '-', b: '-', mic: '-', pending: '', last: '-' };
function lensText(): string {
  return [
    `TTS 시험 ${VERSION}`,
    `목소리: ${state.voices}`,
    `A: ${state.a}`,
    `B: ${state.b}`,
    `녹음: ${state.mic}${state.pending ? `  · ${state.pending}` : ''}`,
    `오디오: ${sessionInfo()}`,
    `입력: ${state.last}`,
    '누르기=A · 두번=멈춤/B · 위=A10초 · 아래=B10초',
  ].join('\n');
}
let bridge: EvenAppBridge | null = null;
let pageReady = false;
let renderQueued = false;
function render(): void {
  $('glasses').textContent = lensText();
  if (!bridge || !pageReady || renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    void bridge!
      .textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'main', content: lensText() }))
      .catch((e: unknown) => log(`화면 갱신 오류 ${String(e)}`));
  }, 200);
}

// ---- A: speechSynthesis --------------------------------------------------------------------
const synth: SpeechSynthesis | undefined = 'speechSynthesis' in window ? window.speechSynthesis : undefined;
let koVoice: SpeechSynthesisVoice | null = null;

function pickVoice(): void {
  if (!synth) {
    state.voices = 'speechSynthesis 없음';
    log('speechSynthesis 없음');
    return render();
  }
  const all = synth.getVoices();
  const ko = all.filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith('ko'));
  const rank = (v: SpeechSynthesisVoice) => (/premium|enhanced|향상|고음질/i.test(v.name) ? 0 : /yuna|유나/i.test(v.name) ? 1 : 2);
  koVoice = [...ko].sort((x, y) => rank(x) - rank(y))[0] ?? null;
  state.voices = `전체 ${all.length} · 한국어 ${ko.length}${koVoice ? ` · ${koVoice.name}` : ''}`;
  log(`목소리 전체 ${all.length}, 한국어: ${ko.map((v) => `${v.name}(${v.lang}${v.localService ? ',local' : ''}${v.default ? ',default' : ''})`).join(' | ') || '없음'}`);
  render();
}

function speakA(text: string, trigger: string): void {
  if (!synth) {
    state.a = '없음';
    return render();
  }
  stopAll('새 읽기');
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ko-KR';
  if (koVoice) u.voice = koVoice;
  u.rate = 1;
  const t0 = performance.now();
  let started = 0;
  let boundaries = 0;
  const tag = `A(${trigger}, ${[...text].length}자)`;
  u.onstart = () => {
    started = performance.now();
    state.a = `읽는 중 · ${trigger} · 시작 ${((started - t0) / 1000).toFixed(2)}s`;
    log(`${tag} 시작 ${Math.round(started - t0)}ms vis=${vis()}`);
    render();
  };
  u.onboundary = () => {
    boundaries++;
  };
  u.onend = () => {
    const dur = started ? (performance.now() - started) / 1000 : 0;
    state.a = `끝 · ${trigger} · ${dur.toFixed(1)}s · 경계 ${boundaries}`;
    log(`${tag} 끝 ${dur.toFixed(1)}s boundary=${boundaries} vis=${vis()}`);
    render();
  };
  u.onerror = (e) => {
    state.a = `오류 ${e.error} · ${trigger}`;
    log(`${tag} 오류 ${e.error} started=${started ? 'Y' : 'N'} vis=${vis()}`);
    render();
  };
  log(`${tag} speak() 오디오=${sessionInfo()} vis=${vis()} speaking=${synth.speaking} pending=${synth.pending} paused=${synth.paused}`);
  synth.speak(u);
  // onstart never firing = silently blocked; report it instead of waiting forever.
  setTimeout(() => {
    if (!started) {
      state.a = `3초 안에 시작 안 됨 · ${trigger}`;
      log(`${tag} 3초 안에 onstart 없음 speaking=${synth.speaking} pending=${synth.pending} vis=${vis()}`);
      render();
    }
  }, 3000);
  state.a = `요청 · ${trigger}`;
  render();
}

// ---- B: <audio> with the Mac-made file -----------------------------------------------------------
const audio = new Audio(sampleUrl);
audio.preload = 'auto';
let bTrigger = '';
let bStarted = 0;
audio.addEventListener('playing', () => {
  bStarted = performance.now();
  state.b = `재생 중 · ${bTrigger}`;
  log(`B(${bTrigger}) playing vis=${vis()}`);
  render();
});
audio.addEventListener('ended', () => {
  const dur = bStarted ? (performance.now() - bStarted) / 1000 : 0;
  state.b = `끝 · ${bTrigger} · ${dur.toFixed(1)}s`;
  log(`B(${bTrigger}) 끝 ${dur.toFixed(1)}s vis=${vis()}`);
  render();
});
audio.addEventListener('error', () => {
  state.b = `파일 오류 ${audio.error?.code ?? '?'}`;
  log(`B 파일 오류 code=${audio.error?.code} ${audio.error?.message ?? ''}`);
  render();
});

function playB(trigger: string): void {
  stopAll('새 재생');
  bTrigger = trigger;
  bStarted = 0;
  audio.currentTime = 0;
  const t0 = performance.now();
  log(`B(${trigger}) play() 오디오=${sessionInfo()} vis=${vis()}`);
  state.b = `요청 · ${trigger}`;
  render();
  audio
    .play()
    .then(() => log(`B(${trigger}) play() 성공 ${Math.round(performance.now() - t0)}ms`))
    .catch((e: unknown) => {
      const name = e instanceof Error ? e.name : String(e);
      state.b = `막힘 ${name} · ${trigger}`;
      log(`B(${trigger}) play() 실패 ${name} ${String(e)} vis=${vis()}`);
      render();
    });
}

function stopAll(why: string): void {
  const was = (synth?.speaking ? 'A ' : '') + (!audio.paused ? 'B' : '');
  synth?.cancel();
  if (!audio.paused) audio.pause();
  if (was.trim()) log(`멈춤(${why}) ${was.trim()}`);
}
const playing = () => Boolean(synth?.speaking) || !audio.paused;

function later(kind: 'A' | 'B', from: string): void {
  state.pending = `${kind} ${LATER_MS / 1000}초 뒤 (지금 잠가 보세요)`;
  log(`${kind} ${LATER_MS / 1000}초 뒤 예약 (${from})`);
  render();
  setTimeout(() => {
    state.pending = '';
    if (kind === 'A') speakA(SHORT, `${from}→10초`);
    else playB(`${from}→10초`);
  }, LATER_MS);
}

async function afterNetwork(from: string): Promise<void> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${RELAY}/healthz`, { cache: 'no-store' });
    log(`healthz ${res.status} ${Math.round(performance.now() - t0)}ms`);
  } catch (e) {
    log(`healthz 실패 ${String(e)} (그래도 읽기 시도)`);
  }
  speakA(SHORT, `${from}→서버응답`);
}

// ---- glasses mic after playback (T0-5) ---------------------------------------------------------
let recording = false;
let bytes = 0;
let frames = 0;
let peakRms = 0;
function onAudio(pcm: Uint8Array): void {
  if (!recording) return;
  frames++;
  bytes += pcm.length;
  // Loudest 50 ms window, same measure as the relay's max_rms.
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let off = 0; off + 1600 <= pcm.length; off += 1600) {
    let sum = 0;
    for (let i = off; i < off + 1600; i += 2) {
      const s = view.getInt16(i, true);
      sum += s * s;
    }
    peakRms = Math.max(peakRms, Math.round(Math.sqrt(sum / 800)));
  }
}
async function record(from: string): Promise<void> {
  if (!bridge || recording) return;
  stopAll('녹음');
  recording = true;
  bytes = frames = peakRms = 0;
  state.mic = '● 3초 (말해 보세요)';
  render();
  let opened = false;
  try {
    opened = await bridge.audioControl(true, AudioInputSource.Glasses);
    log(`녹음(${from}) audioControl → ${opened}`);
    if (opened) await new Promise((r) => setTimeout(r, REC_MS));
  } catch (e) {
    log(`녹음 오류 ${String(e)}`);
  } finally {
    if (opened) await bridge.audioControl(false).catch(() => false);
    recording = false;
    const s = bytes / 32000;
    state.mic = opened ? `${s.toFixed(1)}s ${frames}프레임 최대rms ${peakRms}` : '마이크 열기 실패';
    log(`녹음 끝 ${bytes}B ${frames} frames ${s.toFixed(2)}s max_rms=${peakRms}`);
    render();
  }
}

// ---- inputs ------------------------------------------------------------------------------------
function onHubEvent(ev: EvenHubEvent): void {
  if (ev.audioEvent) return onAudio(ev.audioEvent.audioPcm);
  const sys = ev.sysEvent;
  const txt = ev.textEvent;
  if (!sys && !txt && !ev.listEvent) return;
  if (sys?.eventType === OsEventTypeList.IMU_DATA_REPORT) return;
  const t = sys?.eventType ?? txt?.eventType ?? ev.listEvent?.eventType ?? OsEventTypeList.CLICK_EVENT;
  const g = '안경';
  switch (t) {
    case OsEventTypeList.CLICK_EVENT:
      state.last = '누르기';
      speakA(SHORT, `${g}누르기`);
      break;
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      state.last = '두 번';
      if (playing()) stopAll('안경 두 번');
      else playB(`${g}두번`);
      break;
    case OsEventTypeList.SCROLL_TOP_EVENT:
      state.last = '위로';
      later('A', `${g}위`);
      break;
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      state.last = '아래로';
      later('B', `${g}아래`);
      break;
    case OsEventTypeList.LONG_PRESS_EVENT:
      state.last = '길게';
      void record(`${g}길게`).then(() => speakA(SHORT, `${g}녹음직후`));
      break;
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      log(`앱 뒤로 vis=${vis()} speaking=${synth?.speaking} audio=${audio.paused ? 'paused' : 'playing'}`);
      break;
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
      log(`앱 앞으로 vis=${vis()} speaking=${synth?.speaking} audio=${audio.paused ? 'paused' : 'playing'}`);
      break;
    default:
      return;
  }
  render();
}

const btn = (id: string, f: () => void) => $(id).addEventListener('click', f);
btn('a-now', () => speakA(SHORT, '폰버튼'));
btn('a-long', () => speakA(LONG, '폰버튼'));
btn('a-net', () => void afterNetwork('폰버튼'));
btn('b-now', () => playB('폰버튼'));
btn('a-later', () => later('A', '폰버튼'));
btn('b-later', () => later('B', '폰버튼'));
btn('stop', () => stopAll('폰버튼'));
btn('rec', () => void record('폰버튼'));
btn('rec-a', () => void record('폰버튼').then(() => speakA(SHORT, '녹음직후')));
const TYPES = ['auto', 'playback', 'ambient', 'play-and-record', 'transient', 'transient-solo'];
btn('session', () => {
  const s = audioSession();
  if (!s) return log('navigator.audioSession 없음');
  const before = s.type;
  try {
    s.type = TYPES[(TYPES.indexOf(s.type) + 1) % TYPES.length]!;
  } catch (e) {
    log(`audioSession 바꾸기 실패 ${String(e)}`);
  }
  log(`audioSession ${before} → ${sessionInfo()}`);
  $('session').textContent = `audioSession: ${s.type} (누르면 다음)`;
  render();
});
audioSession()?.addEventListener('statechange', () => {
  log(`audioSession 상태 ${sessionInfo()}`);
  render();
});
document.addEventListener('visibilitychange', () => log(`visibility ${vis()} speaking=${synth?.speaking} audio=${audio.paused ? 'paused' : 'playing'}`));

async function main(): Promise<void> {
  const s = audioSession();
  if (s) $('session').textContent = `audioSession: ${s.type} (누르면 다음)`;
  log(`시작 ${VERSION} origin=${location.origin} UA=${navigator.userAgent}`);
  log(`speechSynthesis=${synth ? '있음' : '없음'} audioSession=${sessionInfo()} sample=${sampleUrl}`);
  pickVoice();
  synth?.addEventListener('voiceschanged', pickVoice);
  render();
  bridge = await waitForEvenAppBridge();
  bridge.onEvenHubEvent(onHubEvent);
  const page = () => ({
    containerTotalNum: 1,
    textObject: [new TextContainerProperty({ xPosition: 0, yPosition: 0, width: 576, height: 288, containerID: 1, containerName: 'main', content: lensText(), isEventCapture: 1 })],
  });
  const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page()));
  pageReady = result === StartUpPageCreateResult.success;
  if (result === StartUpPageCreateResult.invalid) pageReady = await bridge.rebuildPageContainer(new RebuildPageContainer(page())).catch(() => false);
  log(`화면 생성 → ${result} ready=${pageReady}`);
  render();
}

main().catch((e) => log(`시작 오류 ${String(e)}`));
