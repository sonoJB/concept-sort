import { describe, it, expect } from "vitest";
import { isValidLanguage, isValidClusterIndex, isValidSelectedClusterCount } from "./interpretation";

describe("interpretation validators", () => {
  it("accepts only ko/ja as language", () => {
    expect(isValidLanguage("ko")).toBe(true);
    expect(isValidLanguage("ja")).toBe(true);
    expect(isValidLanguage("en")).toBe(false);
    expect(isValidLanguage("KO")).toBe(false);
    expect(isValidLanguage(123)).toBe(false);
  });

  it("validates clusterIndex against selectedClusterCount range", () => {
    expect(isValidClusterIndex(0, 4)).toBe(true);
    expect(isValidClusterIndex(3, 4)).toBe(true);
    expect(isValidClusterIndex(4, 4)).toBe(false);
    expect(isValidClusterIndex(-1, 4)).toBe(false);
    expect(isValidClusterIndex(1.5, 4)).toBe(false);
  });

  it("validates selectedClusterCount is a positive integer", () => {
    expect(isValidSelectedClusterCount(1)).toBe(true);
    expect(isValidSelectedClusterCount(0)).toBe(false);
    expect(isValidSelectedClusterCount(-2)).toBe(false);
    expect(isValidSelectedClusterCount(2.5)).toBe(false);
    expect(isValidSelectedClusterCount("4")).toBe(false);
  });
});
