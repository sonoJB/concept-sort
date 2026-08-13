import { describe, it, expect } from "vitest";
import { validateGuideVideoUrl } from "./guideVideoUrl";

describe("validateGuideVideoUrl", () => {
  it("(17) accepts youtu.be", () => {
    const result = validateGuideVideoUrl("https://youtu.be/aorQRatSvfQ");
    expect(result).toEqual({ ok: true, normalized: "https://youtu.be/aorQRatSvfQ" });
  });

  it("(18) accepts youtube.com and its www/m subdomains", () => {
    expect(validateGuideVideoUrl("https://youtube.com/watch?v=x").ok).toBe(true);
    expect(validateGuideVideoUrl("https://www.youtube.com/watch?v=x").ok).toBe(true);
    expect(validateGuideVideoUrl("https://m.youtube.com/watch?v=x").ok).toBe(true);
  });

  it("(19) rejects http://", () => {
    const result = validateGuideVideoUrl("http://youtu.be/aorQRatSvfQ");
    expect(result.ok).toBe(false);
  });

  it("(20) rejects javascript:", () => {
    const result = validateGuideVideoUrl("javascript:alert(1)");
    expect(result.ok).toBe(false);
  });

  it("rejects data: and file:", () => {
    expect(validateGuideVideoUrl("data:text/html,<script>alert(1)</script>").ok).toBe(false);
    expect(validateGuideVideoUrl("file:///etc/passwd").ok).toBe(false);
  });

  it("(21) rejects a malformed URL", () => {
    const result = validateGuideVideoUrl("not a url at all");
    expect(result.ok).toBe(false);
  });

  it("rejects a well-formed https URL on a non-YouTube host", () => {
    const result = validateGuideVideoUrl("https://vimeo.com/12345");
    expect(result.ok).toBe(false);
  });

  it("(22) empty string normalizes to null", () => {
    expect(validateGuideVideoUrl("")).toEqual({ ok: true, normalized: null });
  });

  it("whitespace-only input normalizes to null (trimmed)", () => {
    expect(validateGuideVideoUrl("   ")).toEqual({ ok: true, normalized: null });
  });

  it("trims surrounding whitespace on a valid URL before storing", () => {
    const result = validateGuideVideoUrl("  https://youtu.be/aorQRatSvfQ  ");
    expect(result).toEqual({ ok: true, normalized: "https://youtu.be/aorQRatSvfQ" });
  });

  it("rejects non-string input", () => {
    expect(validateGuideVideoUrl(null).ok).toBe(false);
    expect(validateGuideVideoUrl(undefined).ok).toBe(false);
    expect(validateGuideVideoUrl(123).ok).toBe(false);
  });
});
