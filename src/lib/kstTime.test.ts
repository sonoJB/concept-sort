import { describe, it, expect } from "vitest";
import { utcIsoToKstInputValue, kstInputValueToUtcIso, formatUtcIsoAsKst } from "./kstTime";

describe("kstTime — KST/JST (UTC+9) conversion, never the browser's local timezone", () => {
  it("converts the exact main-study cutover UTC instant to the KST/JST wall-clock input value", () => {
    expect(utcIsoToKstInputValue("2026-08-16T15:00:00.000Z")).toBe("2026-08-17T00:00");
  });

  it("converts a KST/JST wall-clock input value back to the exact UTC instant", () => {
    expect(kstInputValueToUtcIso("2026-08-17T00:00")).toBe("2026-08-16T15:00:00.000Z");
  });

  it("round-trips through both conversions", () => {
    const original = "2026-08-16T15:00:00.000Z";
    const roundTripped = kstInputValueToUtcIso(utcIsoToKstInputValue(original));
    expect(roundTripped).toBe(original);
  });

  it("null/empty input yields an empty input value and null ISO respectively", () => {
    expect(utcIsoToKstInputValue(null)).toBe("");
    expect(kstInputValueToUtcIso("")).toBeNull();
  });

  it("formats a UTC instant as a human-readable KST/JST string", () => {
    expect(formatUtcIsoAsKst("2026-08-16T15:00:00.000Z")).toBe("2026. 8. 17. 00:00 (KST/JST)");
  });

  it("formats null as 미설정", () => {
    expect(formatUtcIsoAsKst(null)).toBe("미설정");
  });
});
