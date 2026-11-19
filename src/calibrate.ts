// Silence-gate calibration (P1-03 RELAY_STT_MIN_RMS). Reads the relay's own `stt` log lines, which carry
// loudness and lengths only (never the sentence), and suggests a cutoff between silence and speech.

export const MIN_RMS_FLOOR = 50;
export const MIN_RMS_CEIL = 30_000;
export const DEFAULT_MIN_RMS = 500;

export interface SttEntry {
  ts: string;
  audioMs: number;
  maxRms: number;
  noSpeech: boolean;
  chars: number;
  deviceId: string | null;
}

export function parseSttLog(text: string): SttEntry[] {
  const out: SttEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"event":"stt"')) continue;
    try {
      const j = JSON.parse(line) as Record<string, unknown>;
      if (j.event !== 'stt' || typeof j.max_rms !== 'number') continue;
      out.push({ ts: String(j.ts), audioMs: Number(j.audio_ms) || 0, maxRms: j.max_rms, noSpeech: j.no_speech === true, chars: Number(j.chars) || 0, deviceId: typeof j.device_id === 'string' ? j.device_id : null });
    } catch {
      // not JSON (e.g. a stack trace line): skip
    }
  }
  return out;
}

export interface Suggestion {
  cutoff: number | null;
  reason: string;
}

/**
 * Silence side = recordings where no speech was found (gate or whisper), speech side = recordings with text.
 * Cutoff = geometric middle of (loudest silence, quietest speech), only when speech is at least 2x louder.
 * A silent recording that whisper turned into text (hallucination) lands on the speech side, which only lowers
 * the suggestion (more recordings go to whisper), never raises it into real speech.
 */
export function suggestCutoff(entries: SttEntry[]): Suggestion {
  const silent = entries.filter((e) => e.noSpeech && e.maxRms > 0).map((e) => e.maxRms);
  const speech = entries.filter((e) => !e.noSpeech).map((e) => e.maxRms);
  if (!silent.length) return { cutoff: null, reason: '말 없이 한 녹음이 없습니다. 누르고 5초쯤 가만히 있다가 다시 눌러 주세요.' };
  if (!speech.length) return { cutoff: null, reason: '말한 녹음이 없습니다. 조용히 말한 녹음도 한두 개 해 주세요.' };
  const lo = Math.max(...silent);
  const hi = Math.min(...speech);
  if (hi < lo * 2)
    return { cutoff: null, reason: `말 없는 쪽 최대 ${lo}, 말한 쪽 최소 ${hi}: 차이가 2배 미만이라 정할 수 없습니다. 지금 기준을 유지하는 편이 안전합니다.` };
  const cutoff = Math.min(MIN_RMS_CEIL, Math.max(MIN_RMS_FLOOR, Math.round(Math.sqrt(lo * hi) / 10) * 10));
  return { cutoff, reason: `말 없는 쪽 최대 ${lo}, 말한 쪽 최소 ${hi} (${(hi / lo).toFixed(1)}배) 사이의 중간값입니다.` };
}

export function parseMinRms(s: string | undefined): number | null {
  if (!s || !/^\d+$/.test(s.trim())) return null;
  const n = Number(s.trim());
  return n >= MIN_RMS_FLOOR && n <= MIN_RMS_CEIL ? n : null;
}
