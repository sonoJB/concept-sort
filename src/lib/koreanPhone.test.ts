import { describe, it, expect } from "vitest";
import { normalizeKoreanMobile } from "./koreanPhone.mjs";

const n = (s: unknown) => normalizeKoreanMobile(s);

describe("normalizeKoreanMobile", () => {
  it("leaves the standard form untouched", () => {
    expect(n("010-1234-5678")).toEqual({ status: "UNCHANGED", value: "010-1234-5678", rule: null });
  });

  it("hyphenates 11 digits and unifies any space/hyphen mixture", () => {
    for (const raw of ["01012345678", "010 1234 5678", "010-12345678", "0101234-5678", " 010 - 1234 - 5678 ", "010-1234 5678"]) {
      expect(n(raw)).toMatchObject({ status: "NORMALIZED", value: "010-1234-5678" });
    }
  });

  it("restores the leading zero only for exactly 10 digits starting with 10", () => {
    expect(n("1012345678")).toMatchObject({ status: "NORMALIZED", value: "010-1234-5678", rule: "restore-leading-zero" });
    expect(n("10-1234-5678")).toMatchObject({ status: "NORMALIZED", value: "010-1234-5678" });
    // wrong digit counts are never "repaired"
    expect(n("101234567").status).toBe("NEEDS_REVIEW");
    expect(n("10123456789").status).toBe("NEEDS_REVIEW");
  });

  it("converts +82 only when 10 + 8 digits follow", () => {
    expect(n("+82 10-1234-5678")).toMatchObject({ status: "NORMALIZED", value: "010-1234-5678", rule: "+82-to-domestic" });
    expect(n("+821012345678").value).toBe("010-1234-5678");
    expect(n("+82 10-1234-567").status).toBe("NEEDS_REVIEW");
    expect(n("+82 11-1234-5678").status).toBe("NEEDS_REVIEW");
    expect(n("+81 90-1234-5678").status).toBe("NEEDS_REVIEW"); // Japan number is not touched
    expect(n("82 10-1234-5678").status).toBe("NEEDS_REVIEW"); // no '+': ambiguous
  });

  it("reports empty values separately and never fills them in", () => {
    expect(n("")).toMatchObject({ status: "EMPTY", value: "" });
    expect(n("   ")).toMatchObject({ status: "EMPTY", value: "   " });
    expect(n(null).status).toBe("EMPTY");
    expect(n(undefined).status).toBe("EMPTY");
  });

  it("leaves unclear values exactly as given", () => {
    for (const raw of ["010-1234-567", "010-1234-56789", "011-123-4567", "02-123-4567", "abc", "010-1234-5678a", "０１０-１２３４-５６７８", "(010) 1234-5678", "010.1234.5678"]) {
      const r = n(raw);
      expect(r.status).toBe("NEEDS_REVIEW");
      expect(r.value).toBe(raw);
    }
  });

  it("does not turn Japanese last-4 fragments or names into phone numbers", () => {
    for (const raw of ["1234", "0123", "１２３４", "５６７８"]) {
      expect(n(raw).status).toBe("NEEDS_REVIEW");
      expect(n(raw).value).toBe(raw);
    }
  });

  it("is idempotent", () => {
    for (const raw of ["01012345678", "1012345678", "+82 10-1234-5678", "010 1234 5678"]) {
      const once = n(raw);
      const twice = n(once.value);
      expect(twice).toEqual({ status: "UNCHANGED", value: once.value, rule: null });
    }
  });

  it("keeps leading zeros (values are strings)", () => {
    expect(typeof n("01000000000").value).toBe("string");
    expect(n("01000000000").value).toBe("010-0000-0000");
  });
});
