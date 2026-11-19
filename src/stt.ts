// P1-03 speech-to-text on this Mac (docs/p1/P1-design.md §3, §4.2). The glasses' PCM (s16le,
// 16 kHz, mono) goes to whisper.cpp through a WAV file in a private temp directory that is
// removed as soon as whisper exits. Audio never leaves the Mac and is never kept.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export const SAMPLE_RATE = 16_000;
export const MAX_AUDIO_MS = 30_000;
export const MAX_PCM_BYTES = (SAMPLE_RATE * 2 * MAX_AUDIO_MS) / 1000; // 960,000
export const MIN_PCM_BYTES = (SAMPLE_RATE * 2 * 300) / 1000; // 0.3 s

export interface Transcriber {
  readonly model: string;
  available(): boolean;
  transcribe(pcm: Buffer): Promise<string>;
}

/** Length and loudness. maxFrameRms = RMS of the loudest 50 ms frame (speech vs. room noise). */
export function pcmStats(pcm: Buffer): { audioMs: number; maxFrameRms: number } {
  const samples = Math.floor(pcm.length / 2);
  const frame = SAMPLE_RATE / 20;
  let max = 0;
  for (let start = 0; start < samples; start += frame) {
    const end = Math.min(samples, start + frame);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const s = pcm.readInt16LE(i * 2);
      sum += s * s;
    }
    max = Math.max(max, Math.sqrt(sum / (end - start)));
  }
  return { audioMs: Math.round((samples / SAMPLE_RATE) * 1000), maxFrameRms: Math.round(max) };
}

/** whisper output → one plain line; drops "[음악]"/"(박수)"-style non-speech tags and dialogue dashes. */
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]|\([^)]*\)|（[^）]*）/g, ' ')
    .replace(/(^|\s)-\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function wav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export class WhisperCli implements Transcriber {
  readonly model: string;
  private readonly bin: string;
  private readonly modelPath: string;

  constructor(o: { bin: string; modelPath: string }) {
    this.bin = o.bin;
    this.modelPath = o.modelPath;
    this.model = basename(o.modelPath).replace(/^ggml-|\.bin$/g, '');
  }

  available(): boolean {
    return existsSync(this.bin) && existsSync(this.modelPath);
  }

  async transcribe(pcm: Buffer): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'relay-stt-')); // 0700
    const file = join(dir, 'a.wav');
    try {
      await writeFile(file, wav(pcm), { mode: 0o600 });
      const out = await new Promise<string>((resolve, reject) => {
        execFile(
          this.bin,
          ['-m', this.modelPath, '-l', 'ko', '-nt', '-np', '-t', '4', '-f', file],
          { timeout: 60_000, maxBuffer: 1 << 20, encoding: 'utf8' },
          (err, stdout) => (err ? reject(new Error(`whisper_failed: ${err.code ?? err.signal ?? 'error'}`)) : resolve(stdout)),
        );
      });
      return cleanTranscript(out);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** Tests: returns a fixed sentence and counts calls. */
export class FakeTranscriber implements Transcriber {
  readonly model = 'fake';
  calls = 0;
  text: string;
  constructor(text = '다음 주 세미나 준비 상황 알려줘') {
    this.text = text;
  }
  available(): boolean {
    return true;
  }
  async transcribe(_pcm: Buffer): Promise<string> {
    this.calls++;
    return this.text;
  }
}
