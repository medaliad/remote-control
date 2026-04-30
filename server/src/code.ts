import { randomBytes } from "node:crypto";
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function generateCode(length = 6): string {
  const out: string[] = [];
  const bytes = randomBytes(length * 2);
  let i = 0;
  while (out.length < length && i < bytes.length) {
    const b = bytes[i++]!;
    if (b < ALPHABET.length * Math.floor(256 / ALPHABET.length)) {
      out.push(ALPHABET[b % ALPHABET.length]!);
    }
  }
  while (out.length < length) {
    const b = randomBytes(1)[0]!;
    if (b < ALPHABET.length * Math.floor(256 / ALPHABET.length)) {
      out.push(ALPHABET[b % ALPHABET.length]!);
    }
  }
  return out.join("");
}
export function normalizeCode(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}
