/**
 * Generates human-readable session IDs like "swift-tiger-4821".
 * Easy to read aloud, type, or share via QR / link.
 */

const ADJECTIVES = [
  "swift", "brave", "calm", "dark", "fast", "keen", "bold", "cold",
  "warm", "wise", "pure", "vast", "free", "deep", "rich", "firm",
  "glad", "cool", "fair", "safe", "epic", "wild", "loud", "soft",
];

const NOUNS = [
  "tiger", "panda", "wolf", "hawk", "lion", "bear", "fox", "owl",
  "lynx", "deer", "crow", "seal", "mink", "kite", "wren", "ibis",
  "pike", "carp", "fern", "jade", "oak",  "reef", "moon", "star",
];

/** Returns a random ID like "swift-tiger-4821". */
export function generateSessionId(): string {
  const adj  = pick(ADJECTIVES);
  const noun = pick(NOUNS);
  const num  = Math.floor(Math.random() * 9_000) + 1_000;
  return `${adj}-${noun}-${num}`;
}

function pick(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)] ?? arr[0]!;
}
