/**
 * Korean mobile phone number normalisation — single source of truth, shared by
 * the participant submission route (new data) and the one-off production data
 * clean-up script (existing data). Plain JavaScript so the script can run in
 * the production container without a TypeScript toolchain.
 *
 * Applies ONLY to participants whose stored countryCode is "KR". Callers must
 * never pass Japanese phone fragments or any participant name through it.
 *
 * A value is changed only when it is unambiguous; anything else is reported as
 * NEEDS_REVIEW and left exactly as it was. Nothing is ever guessed or filled in.
 *
 * Accepted (→ "010-dddd-dddd"):
 *   - 010-dddd-dddd                (already standard → UNCHANGED)
 *   - 010dddddddd and any placement of spaces/hyphens between exactly 11 digits starting 010
 *   - exactly 10 digits starting with 10 ("1012345678", "10-1234-5678") → leading 0 restored
 *   - "+82" immediately followed by 10 + 8 digits ("+82 10-1234-5678") → domestic form
 *
 * Idempotent: normalising an already normalised value returns UNCHANGED.
 */

/** @typedef {"UNCHANGED"|"NORMALIZED"|"EMPTY"|"NEEDS_REVIEW"} KoreanPhoneStatus */

const STANDARD = /^010-\d{4}-\d{4}$/;

/** @param {string} d exactly 11 digits starting with 010 */
function format(d) {
  return `010-${d.slice(3, 7)}-${d.slice(7, 11)}`;
}

/**
 * @param {unknown} raw stored or submitted phone value of a Korean participant
 * @returns {{ status: KoreanPhoneStatus, value: string, rule: string | null }}
 *   `value` is the normalised number for UNCHANGED/NORMALIZED, otherwise the
 *   input exactly as given (never altered).
 */
export function normalizeKoreanMobile(raw) {
  if (typeof raw !== "string") {
    return { status: "EMPTY", value: "", rule: null };
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { status: "EMPTY", value: raw, rule: null };
  }
  if (STANDARD.test(raw)) {
    return { status: "UNCHANGED", value: raw, rule: null };
  }

  // Only ASCII digits, whitespace, hyphens and a single leading "+" are understood.
  if (!/^\+?[0-9\s-]+$/.test(trimmed)) {
    return { status: "NEEDS_REVIEW", value: raw, rule: null };
  }
  const hasPlus = trimmed.startsWith("+");
  const body = trimmed.replace(/[\s-]/g, "").replace(/^\+/, "");

  if (hasPlus) {
    const m = body.match(/^82(10\d{8})$/);
    if (m) return { status: "NORMALIZED", value: format("0" + m[1]), rule: "+82-to-domestic" };
    return { status: "NEEDS_REVIEW", value: raw, rule: null };
  }
  if (/^010\d{8}$/.test(body)) {
    return { status: "NORMALIZED", value: format(body), rule: "hyphenate-11-digits" };
  }
  if (/^10\d{8}$/.test(body)) {
    return { status: "NORMALIZED", value: format("0" + body), rule: "restore-leading-zero" };
  }
  return { status: "NEEDS_REVIEW", value: raw, rule: null };
}
