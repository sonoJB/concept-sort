import { describe, it, expect } from "vitest";
import { canonicalize, canonicalJsonStringify, canonicalHash } from "./canonicalJson";

describe("canonicalize", () => {
  it("keeps null as null, distinct from empty string", () => {
    expect(canonicalHash({ a: null })).not.toBe(canonicalHash({ a: "" }));
  });

  it("produces identical hashes regardless of object key insertion order", () => {
    const a = canonicalHash({ x: 1, y: 2, z: 3 });
    const b = canonicalHash({ z: 3, x: 1, y: 2 });
    expect(a).toBe(b);
  });

  it("produces different hashes when array order differs", () => {
    const a = canonicalHash({ items: [1, 2, 3] });
    const b = canonicalHash({ items: [3, 2, 1] });
    expect(a).not.toBe(b);
  });

  it("rejects NaN", () => {
    expect(() => canonicalize({ v: NaN })).toThrow(TypeError);
  });

  it("rejects Infinity and -Infinity", () => {
    expect(() => canonicalize({ v: Infinity })).toThrow(TypeError);
    expect(() => canonicalize({ v: -Infinity })).toThrow(TypeError);
  });

  it("rejects undefined rather than silently dropping it", () => {
    expect(() => canonicalize({ v: undefined })).toThrow(TypeError);
  });

  it("canonicalizes -0 to 0", () => {
    expect(canonicalJsonStringify({ v: -0 })).toBe(canonicalJsonStringify({ v: 0 }));
  });

  it("preserves nested array order but not object key order", () => {
    const a = canonicalJsonStringify({ b: [1, 2], a: { y: 2, x: 1 } });
    const b = canonicalJsonStringify({ a: { x: 1, y: 2 }, b: [1, 2] });
    expect(a).toBe(b);
  });

  it("hashes deterministically for the same canonical input across calls", () => {
    const value = { scope: "KR", n: 5, matrix: [[1, 2], [3, 4]] };
    expect(canonicalHash(value)).toBe(canonicalHash(value));
  });
});
