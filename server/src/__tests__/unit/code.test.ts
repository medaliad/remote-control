import { describe, it, expect } from "vitest";
import { generateCode, normalizeCode } from "../../code.js";
import * as L from "../helpers/logger.js";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
// I, O, L, 0, 1 are intentionally absent to avoid visual confusion.
const EXCLUDED = "IOL01";

// ─── generateCode ────────────────────────────────────────────────────────────

describe("generateCode — session code generator", () => {
  it("returns a string of the requested length", () => {
    L.section("generateCode — length");
    for (const len of [4, 6, 8, 12]) {
      const code = generateCode(len);
      L.ok(`length ${len}`, code);
      expect(code).toHaveLength(len);
    }
  });

  it("uses only characters from the unambiguous alphabet (32 chars)", () => {
    L.section("generateCode — alphabet safety");
    L.step("Alphabet", ALPHABET);
    L.step("Generating 300 codes and checking every character...");
    for (let i = 0; i < 300; i++) {
      const code = generateCode(6);
      for (const ch of code) {
        expect(ALPHABET, `"${ch}" must be in alphabet`).toContain(ch);
      }
    }
    L.ok("All 300 codes contain only alphabet characters");
  });

  it("never contains visually confusable characters (I O L 0 1)", () => {
    L.section("generateCode — no confusable chars");
    L.step("Excluded chars", EXCLUDED);
    const sample = Array.from({ length: 300 }, () => generateCode(6)).join("");
    for (const ch of EXCLUDED) {
      L.step(`Checking "${ch}" is absent from 1800-char sample...`);
      expect(sample).not.toContain(ch);
    }
    L.ok(`None of "${EXCLUDED}" found — zero visual ambiguity`);
  });

  it("produces statistically unique codes across 200 calls", () => {
    L.section("generateCode — uniqueness");
    const codes = new Set(Array.from({ length: 200 }, () => generateCode(6)));
    L.ok(`Unique codes out of 200 calls`, String(codes.size));
    // With 32^6 ≈ 1 billion possibilities, collisions in 200 draws are vanishingly rare.
    // Tightened from > 190 to >= 199 (allow at most 1 freak collision).
    expect(codes.size).toBeGreaterThanOrEqual(199);
  });

  it("always returns uppercase", () => {
    L.section("generateCode — uppercase only");
    for (let i = 0; i < 50; i++) {
      const code = generateCode(6);
      expect(code).toBe(code.toUpperCase());
    }
    L.ok("50 samples — all uppercase");
  });

  it("returns different values on sequential calls (randomness sanity check)", () => {
    L.section("generateCode — sequential calls differ");
    const a = generateCode(6);
    const b = generateCode(6);
    L.step("Code A", a);
    L.step("Code B", b);
    expect(a).toHaveLength(6);
    expect(b).toHaveLength(6);
    // Not a strict guarantee but demonstrates the randomness.
    expect(a).not.toBe(b);
    L.ok("Two consecutive codes differ");
  });
});

// ─── normalizeCode ───────────────────────────────────────────────────────────

describe("normalizeCode — input sanitiser", () => {
  const cases: [string, string, string][] = [
    ["AB CD EF",  "ABCDEF", "strips spaces"],
    ["AB-CD-EF",  "ABCDEF", "strips hyphens"],
    ["abcdef",    "ABCDEF", "uppercases lowercase"],
    ["ab-cd ef",  "ABCDEF", "strips mixed spaces and hyphens + uppercases"],
    ["ABCDEF",    "ABCDEF", "passes already-normalised code unchanged"],
    ["",          "",       "handles empty string"],
    ["  ABCDEF ", "ABCDEF", "handles leading and trailing whitespace"],
    ["AB--CD",    "ABCD",   "handles double hyphens"],
    ["a b-c d",   "ABCD",   "handles interleaved spaces and hyphens"],
  ];

  it("normalises all known input patterns correctly", () => {
    L.section("normalizeCode — transformation table");
    for (const [raw, expected, label] of cases) {
      const result = normalizeCode(raw);
      L.step(`"${raw}"`, `→  "${result}"  (${label})`);
      expect(result).toBe(expected);
    }
    L.ok(`All ${cases.length} transformation cases passed`);
  });

  it("is idempotent — normalising twice gives the same result", () => {
    L.section("normalizeCode — idempotency");
    const inputs = ["ab-cd", "AB CD", "a b c d e f"];
    for (const raw of inputs) {
      const once  = normalizeCode(raw);
      const twice = normalizeCode(once);
      L.step(`Input "${raw}"  →  once:"${once}"  →  twice:"${twice}"`);
      expect(twice).toBe(once);
    }
    L.ok("Idempotency confirmed for all samples");
  });
});
