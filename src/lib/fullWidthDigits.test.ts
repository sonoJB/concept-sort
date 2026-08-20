import { describe, it, expect } from "vitest";
import { normalizeFullWidthDigits, isValidJapanesePhoneLast4 } from "./fullWidthDigits";

describe("normalizeFullWidthDigits", () => {
  it("converts full-width digits to ASCII", () => {
    expect(normalizeFullWidthDigits("１２３４")).toBe("1234");
  });

  it("preserves a leading zero through normalization", () => {
    expect(normalizeFullWidthDigits("０１２３")).toBe("0123");
  });

  it("leaves ASCII digits unchanged", () => {
    expect(normalizeFullWidthDigits("1234")).toBe("1234");
  });

  it("leaves non-digit characters untouched, including other full-width punctuation", () => {
    expect(normalizeFullWidthDigits("１２－３４")).toBe("12－34");
    expect(normalizeFullWidthDigits("abcd")).toBe("abcd");
  });

  it("handles a mix of full-width and ASCII digits", () => {
    expect(normalizeFullWidthDigits("１2３4")).toBe("1234");
  });
});

describe("isValidJapanesePhoneLast4", () => {
  it("accepts exactly 4 ASCII digits", () => {
    expect(isValidJapanesePhoneLast4("1234")).toBe(true);
  });

  it("accepts exactly 4 digits with a leading zero", () => {
    expect(isValidJapanesePhoneLast4("0123")).toBe(true);
  });

  it("accepts 4 full-width digits, normalizing first", () => {
    expect(isValidJapanesePhoneLast4("１２３４")).toBe(true);
  });

  it("accepts 4 full-width digits with a leading zero, preserving it", () => {
    expect(isValidJapanesePhoneLast4("０１２３")).toBe(true);
  });

  it("rejects fewer than 4 digits", () => {
    expect(isValidJapanesePhoneLast4("123")).toBe(false);
  });

  it("rejects more than 4 digits", () => {
    expect(isValidJapanesePhoneLast4("12345")).toBe(false);
  });

  it("rejects a full phone number", () => {
    expect(isValidJapanesePhoneLast4("09012345678")).toBe(false);
    expect(isValidJapanesePhoneLast4("090-1234-5678")).toBe(false);
  });

  it("rejects non-digit characters mixed with digits", () => {
    expect(isValidJapanesePhoneLast4("12a4")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidJapanesePhoneLast4("")).toBe(false);
  });
});
