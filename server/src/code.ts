import { randomBytes } from "node:crypto";

/**
 * Generate short, human-readable session codes.
 *
 * Alphabet avoids the usual confusable pairs (0/O, 1/I/L) so a user can read
 * the code off a screen and type it into a phone without squinting.
 *
 * 6 chars × 30-symbol alphabet = ~729M combinations. More than enough for a
 * small-scale internal tool where codes live only until the host disconnects.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0, O, 1, I, L

export function generateCode(length = 6): string {
  // randomBytes gives us uniform bytes; we reject-sample to avoid modulo bias.
  const out: string[] = [];
  const bytes = randomBytes(length * 2);
  let i = 0;
  while (out.length < length && i < bytes.length) {
    const b = bytes[i++]!;
    if (b < ALPHABET.length * Math.floor(256 / ALPHABET.length)) {
      out.push(ALPHABET[b % ALPHABET.length]!);
    }
  }
  // Extreme edge case: exhausted all 2L bytes without filling. Top up from
  // a fresh pool; this branch is effectively unreachable but cheap.
  while (out.length < length) {
    const b = randomBytes(1)[0]!;
    if (b < ALPHABET.length * Math.floor(256 / ALPHABET.length)) {
      out.push(ALPHABET[b % ALPHABET.length]!);
    }
  }
  return out.join("");
}

/** Normalize user input: uppercase, strip whitespace and dashes. */
export function normalizeCode(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}
