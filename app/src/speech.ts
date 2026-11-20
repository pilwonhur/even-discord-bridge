// Read Chris's reply aloud on the iPhone (docs/p1/tts-design.md, A: speechSynthesis).
// G2 has no speaker; the Even app WebView plays through the iPhone speaker or connected earphones.
// T0 spike (device-test-plan §1.5): starting from a glasses event, a timer, or with the phone locked works.
import { speechText } from './speechText.ts';

// Web Audio Session API (WebKit, iOS 17+): lets the page ask for an iOS audio category. The output route
// (AirPods vs iPhone speaker) follows that category, which the Even app also sets for its own needs. May be
// missing in the Even WebView; then the route is whatever the Even app chose.
interface AudioSessionLike extends EventTarget {
  type: string;
  readonly state?: string;
}
export function audioSession(): AudioSessionLike | undefined {
  return (navigator as unknown as { audioSession?: AudioSessionLike }).audioSession;
}
export function sessionInfo(): string {
  const s = audioSession();
  return s ? `${s.type}/${s.state ?? '?'}` : '없음';
}

export interface SpeakerHooks {
  onChange(speaking: boolean): void;
  log(msg: string): void;
}

export class Speaker {
  private readonly synth: SpeechSynthesis | undefined = 'speechSynthesis' in window ? window.speechSynthesis : undefined;
  private voice: SpeechSynthesisVoice | null = null;
  private current: SpeechSynthesisUtterance | null = null;
  private readonly hooks: SpeakerHooks;
  /** Diagnostic (AirPods vs speaker): ask for the 'playback' audio session while reading, then put it back. */
  forcePlayback = false;
  private restoreType: string | null = null;

  constructor(hooks: SpeakerHooks) {
    this.hooks = hooks;
    if (!this.synth) {
      hooks.log('음성 읽기 불가: speechSynthesis 없음');
      return;
    }
    this.pickVoice();
    this.synth.addEventListener('voiceschanged', () => this.pickVoice());
  }

  get available(): boolean {
    return Boolean(this.synth);
  }

  get speaking(): boolean {
    return this.current !== null;
  }

  private pickVoice(): void {
    const ko = this.synth!.getVoices().filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith('ko'));
    const rank = (v: SpeechSynthesisVoice) => (/premium|enhanced|향상|고음질/i.test(v.name) ? 0 : /yuna|유나/i.test(v.name) ? 1 : 2);
    const best = [...ko].sort((x, y) => rank(x) - rank(y))[0] ?? null;
    if (best && best !== this.voice) this.hooks.log(`음성 목소리 ${best.name} (한국어 ${ko.length}개)`);
    this.voice = best;
  }

  /** Read the reply from the start; any earlier reading is cancelled. Returns false if there is nothing to read. */
  speak(reply: string): boolean {
    if (!this.synth) return false;
    const text = speechText(reply);
    if (!text) {
      this.stop();
      return false;
    }
    this.stop(true);
    const before = sessionInfo();
    this.claimSession();
    this.hooks.log(`읽기 준비 오디오 ${before}${this.restoreType !== null ? ` → ${sessionInfo()}` : ''}`);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR';
    if (this.voice) u.voice = this.voice;
    u.rate = 1;
    const t0 = performance.now();
    let startedAt = 0;
    const done = (how: string) => {
      if (this.current !== u) return; // a newer reading or stop() took over
      this.current = null;
      this.releaseSession();
      this.hooks.log(`읽기 ${how}${startedAt ? ` ${((performance.now() - startedAt) / 1000).toFixed(1)}s` : ''}`);
      this.hooks.onChange(false);
    };
    u.onstart = () => {
      startedAt = performance.now();
      this.hooks.log(`읽기 시작 ${[...text].length}자 (${Math.round(startedAt - t0)}ms)`);
    };
    u.onend = () => done('끝');
    u.onerror = (e) => done(e.error === 'canceled' || e.error === 'interrupted' ? '멈춤' : `실패 ${e.error}`);
    this.current = u;
    this.synth.speak(u);
    this.hooks.onChange(true);
    return true;
  }

  /** Stop reading now. cancel() fires onerror('canceled'), which done() ignores because current is cleared first. */
  stop(quiet = false): void {
    if (!this.synth || !this.current) return;
    this.current = null;
    this.synth.cancel();
    if (quiet) return; // a new reading follows and keeps the session claim
    this.releaseSession();
    this.hooks.log('읽기 멈춤');
    this.hooks.onChange(false);
  }

  private claimSession(): void {
    const s = audioSession();
    if (!this.forcePlayback || !s || this.restoreType !== null) return;
    try {
      this.restoreType = s.type;
      s.type = 'playback';
    } catch (e) {
      this.restoreType = null;
      this.hooks.log(`오디오 playback 요청 실패 ${String(e)}`);
    }
  }

  private releaseSession(): void {
    const s = audioSession();
    if (!s || this.restoreType === null) return;
    try {
      s.type = this.restoreType;
    } catch {
      // keep going; the next claim will try again
    }
    this.restoreType = null;
  }
}
