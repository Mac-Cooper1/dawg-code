/** Dice similarity of two strings over character pairs: 1 for equal, 0 for nothing in common. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const pairs = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const pair = a.slice(i, i + 2);
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const pair = b.slice(i, i + 2);
    const count = pairs.get(pair) ?? 0;
    if (count > 0) {
      pairs.set(pair, count - 1);
      shared++;
    }
  }
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

/** The form of a line used to compare it loosely: trimmed, with runs of whitespace as one space. */
export function looseKey(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}
