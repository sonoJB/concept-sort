import { describe, it, expect } from "vitest";
import { toStoredSeed, fromStoredSeed } from "./executionService";

// toStoredSeed/fromStoredSeed are a private adapter boundary, not a public
// input validator: they only ever receive values the verified engine's own
// u32 PRNG already produced (DimensionResult.bestSeed), or a value
// previously round-tripped through toStoredSeed. Adding range/type guards
// here would duplicate validation the engine already performs and that this
// adapter has no independent way to check meaningfully — so this suite
// covers round-trip correctness, not out-of-contract input handling.
describe("seed storage encoding — signed Int32 reinterpretation of an unsigned 32-bit seed", () => {
  it("round-trips the full unsigned 32-bit range exactly", () => {
    const values = [0, 1, 2147483647, 2147483648, 4294967294, 4294967295];
    for (const v of values) {
      expect(fromStoredSeed(toStoredSeed(v))).toBe(v);
    }
  });

  it("fixes the exact bit-pattern semantics at the signed/unsigned boundary", () => {
    expect(toStoredSeed(2147483647)).toBe(2147483647); // max positive signed Int32 — unchanged
    expect(toStoredSeed(2147483648)).toBe(-2147483648); // first value that flips sign
    expect(toStoredSeed(4294967295)).toBe(-1); // max unsigned 32-bit
  });

  it("passes through null unchanged in both directions", () => {
    expect(toStoredSeed(null)).toBeNull();
    expect(fromStoredSeed(null)).toBeNull();
  });
});
