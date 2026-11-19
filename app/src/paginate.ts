// Split Chris's reply into lens pages (FR-15). Pure function so the root test suite can check it.
// Breaks on line boundaries first, then on spaces, and only mid-word when a single word is too long.

export function paginate(text: string, maxChars: number): string[] {
  const pages: string[] = [];
  let cur = '';
  const flush = () => {
    const t = cur.trim();
    if (t) pages.push(t);
    cur = '';
  };
  const len = (s: string) => [...s].length;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const piece = cur ? `${cur}\n${line}` : line;
    if (len(piece) <= maxChars) {
      cur = piece;
      continue;
    }
    flush();
    // The line alone is too long: fill pages word by word.
    let rest = line;
    while (len(rest) > maxChars) {
      const chars = [...rest];
      const head = chars.slice(0, maxChars).join('');
      const cut = head.lastIndexOf(' ');
      const take = cut > maxChars / 2 ? head.slice(0, cut) : head;
      pages.push(take.trim());
      rest = rest.slice(take.length).trimStart();
    }
    cur = rest;
  }
  flush();
  return pages.length ? pages : [''];
}
