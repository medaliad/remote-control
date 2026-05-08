import { randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
// Largest multiple of ALPHABET.length that fits in a byte — bytes at or above
// this threshold are discarded to eliminate modulo bias.
const BIAS_LIMIT = ALPHABET.length * Math.floor(256 / ALPHABET.length);

export function generateCode(length = 6): string {
  const out: string[] = [];
  const bytes = randomBytes(length * 2);
  let i = 0;
  while (out.length < length && i < bytes.length) {
    const b = bytes[i++]!;
    if (b < BIAS_LIMIT) out.push(ALPHABET[b % ALPHABET.length]!);
  }
  while (out.length < length) {
    const b = randomBytes(1)[0]!;
    if (b < BIAS_LIMIT) out.push(ALPHABET[b % ALPHABET.length]!);
  }
  return out.join("");
}
export function normalizeCode(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}
