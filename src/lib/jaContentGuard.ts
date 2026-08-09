/**
 * Structural detectors used to keep Japanese-facing content (consentJa,
 * titleJa, promptJa, textJa) free of unapproved contact details and
 * unresolved template placeholders. These are heuristics over free text —
 * not a schema field — so they report *why* something matched instead of
 * silently blocking, letting an admin judge edge cases.
 */

export type GuardViolation = { pattern: string; matchedText: string };

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const MAILTO_PATTERN = /mailto:/gi;
const TEL_LINK_PATTERN = /tel:/gi;
// Phone-shaped digit runs: groups of 2-4 digits joined by hyphens/dashes,
// optionally prefixed with +country code or a parenthesized area code.
// Requires at least two separators so a lone "2024-2025" style year range or
// a statement number doesn't trip it.
const PHONE_PATTERN =
  /(\+?\d{1,4}[-\s]?)?\(?\d{2,4}\)?[-–]\d{2,4}[-–]\d{3,4}/g;

/** Detects email/mailto/tel/phone-shaped strings anywhere in `text`. */
export function detectDisallowedContact(text: string | null | undefined): {
  found: boolean;
  violations: GuardViolation[];
} {
  const violations: GuardViolation[] = [];
  if (!text) return { found: false, violations };

  for (const [pattern, label] of [
    [EMAIL_PATTERN, "이메일 주소 형식"],
    [MAILTO_PATTERN, "mailto: 링크"],
    [TEL_LINK_PATTERN, "tel: 링크"],
    [PHONE_PATTERN, "전화번호로 보이는 패턴"],
  ] as const) {
    const matches = text.match(pattern);
    if (matches) {
      for (const matchedText of matches) {
        violations.push({ pattern: label, matchedText });
      }
    }
  }

  return { found: violations.length > 0, violations };
}

const PLACEHOLDER_LITERALS = [
  "TODO",
  "TBD",
  "FIXME",
  "미정",
  "추후 입력",
  "要確認",
  "未定",
];

// Words that mark a bracketed span as an unfilled template slot rather than
// a normal document heading like "［研究参加および個人情報の利用に関する同意書］".
// Matched against the bracket's *contents*, not the bracket character itself
// — a real title inside brackets never trips this.
const PLACEHOLDER_CUE_PATTERN =
  /TODO|TBD|FIXME|未定|要確認|記載|入力|ここに|xxx|placeholder|미정|추후\s*입력|입력하세요|작성하세요/i;

function findBracketedPlaceholders(text: string): GuardViolation[] {
  const violations: GuardViolation[] = [];
  for (const bracketRegex of [/［([^］]*)］/g, /\[([^\]]*)\]/g]) {
    for (const match of text.matchAll(bracketRegex)) {
      const inner = match[1];
      if (inner.trim() === "" || PLACEHOLDER_CUE_PATTERN.test(inner)) {
        violations.push({ pattern: "미확정 템플릿 대괄호", matchedText: match[0] });
      }
    }
  }
  return violations;
}

/**
 * Flags unresolved template markers: known placeholder literals anywhere in
 * the text, plus bracketed spans (［…］ or […]) whose *contents* look like an
 * unfilled slot (empty, or containing a fill-in-the-blank cue word). Ordinary
 * document headings in brackets — e.g. "［研究参加および個人情報の利用に関す
 * る同意書］" — are never flagged just for being bracketed.
 */
export function detectPlaceholder(text: string | null | undefined): {
  found: boolean;
  violations: GuardViolation[];
} {
  const violations: GuardViolation[] = [];
  if (!text) return { found: false, violations };

  for (const literal of PLACEHOLDER_LITERALS) {
    if (text.toUpperCase().includes(literal.toUpperCase())) {
      violations.push({ pattern: "미확정 템플릿 표현", matchedText: literal });
    }
  }
  violations.push(...findBracketedPlaceholders(text));

  return { found: violations.length > 0, violations };
}
