export type UnicodeFinding = { issue: string; count: number };

/**
 * Characters that must never appear in participant-facing text: rendering
 * artifacts (replacement/tofu characters) and checkbox glyphs the source
 * workbook does not use for the five similarity-sorting rules. Legitimate
 * source punctuation (①②③④⑤, ※, ［ ］, 「 」, （ ）, 、, 。, ・, –, —, <기타>
 * as literal text) is intentionally NOT in this list.
 */
const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: "U+FFFD REPLACEMENT CHARACTER", re: /�/g },
  { name: "U+25A1 WHITE SQUARE", re: /□/g },
  { name: "U+25A0 BLACK SQUARE", re: /■/g },
  { name: "U+2610 BALLOT BOX", re: /☐/g },
  { name: "U+2611 BALLOT BOX WITH CHECK", re: /☑/g },
  { name: "U+2612 BALLOT BOX WITH X", re: /☒/g },
  { name: "Private Use Area U+E000-U+F8FF", re: /[-]/g },
  { name: "Zero-width space U+200B", re: /​/g },
  { name: "BOM/ZWNBSP U+FEFF", re: /﻿/g },
  { name: "Unexpected control character", re: /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g },
];

export function findForbiddenCharacters(text: string): UnicodeFinding[] {
  const findings: UnicodeFinding[] = [];
  for (const f of FORBIDDEN) {
    const matches = text.match(f.re);
    if (matches) findings.push({ issue: f.name, count: matches.length });
  }
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        findings.push({ issue: "Unpaired high surrogate", count: 1 });
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      const prev = text.charCodeAt(i - 1);
      if (!(prev >= 0xd800 && prev <= 0xdbff)) {
        findings.push({ issue: "Unpaired low surrogate", count: 1 });
      }
    }
  }
  return findings;
}

/** Recursively collects every string leaf value from a nested object/array, skipping functions. */
export function collectStringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStringLeaves(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectStringLeaves(v, out);
  }
  return out;
}
