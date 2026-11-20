// Turn Chris's reply (already cleaned by the relay: no request ID, no markdown emphasis) into text that
// reads well aloud (docs/p1/tts-design.md §4). Pure function so the root test suite can check it.

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi;
// Emoji and their glue (variation selector, zero-width joiner, keycap), skin tones.
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}️‍⃣]/gu;
// Decoration the voice would spell out or that has no sound.
const DECOR_RE = /[*_~`#>|•▪▶►▷■□◆◇★☆※→←↑↓⇒]/g;
const END_RE = /[.!?。…:;,]$/;

export function speechText(reply: string): string {
  const parts: string[] = [];
  for (const raw of reply.replace(/\r/g, '').split('\n')) {
    let line = raw
      .replace(URL_RE, '링크')
      .replace(EMOJI_RE, '')
      .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '') // list markers; the line break below already gives a pause
      .replace(/\s·\s/g, ', ')
      .replace(DECOR_RE, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!/[\p{L}\p{N}]/u.test(line)) continue;
    // A heading-like line with no ending would run into the next one; give it a full stop.
    if (!END_RE.test(line)) line += '.';
    parts.push(line);
  }
  return parts.join(' ');
}
