import { describe, it, expect } from "vitest";
import { findForbiddenCharacters, collectStringLeaves } from "./unicodeAudit";
import { ko } from "@/messages/participant/ko";
import { ja } from "@/messages/participant/ja";
import { getStudyWebAppText, getStudyGuidePageOverride } from "./studyWebAppText";

describe("findForbiddenCharacters", () => {
  it("returns empty for clean text", () => {
    expect(findForbiddenCharacters("유사성 분류 작업 시, 다음의 5가지 지침을 반드시 준수해 주십시오.")).toEqual([]);
    expect(findForbiddenCharacters("類似性に基づくカード分類")).toEqual([]);
  });

  it("does not flag legitimate source punctuation", () => {
    const clean =
      "①②③④⑤ ※ ［ ］ 「 」 （ ） 、 。 ・ – — <기타> 개인정보 딥페이크 匿名性 非言語的手がかり ディープフェイク 恥ずかしやや屈辱感";
    expect(findForbiddenCharacters(clean)).toEqual([]);
  });

  it("flags U+FFFD", () => {
    expect(findForbiddenCharacters("깨진 문자 �")).toEqual([{ issue: "U+FFFD REPLACEMENT CHARACTER", count: 1 }]);
  });

  it("flags unexpected checkbox glyphs", () => {
    expect(findForbiddenCharacters("☐")).toEqual([{ issue: "U+2610 BALLOT BOX", count: 1 }]);
    expect(findForbiddenCharacters("☑")).toEqual([
      { issue: "U+2611 BALLOT BOX WITH CHECK", count: 1 },
    ]);
    expect(findForbiddenCharacters("☒")).toEqual([{ issue: "U+2612 BALLOT BOX WITH X", count: 1 }]);
  });

  it("flags white/black square", () => {
    expect(findForbiddenCharacters("□")).toEqual([{ issue: "U+25A1 WHITE SQUARE", count: 1 }]);
    expect(findForbiddenCharacters("■")).toEqual([{ issue: "U+25A0 BLACK SQUARE", count: 1 }]);
  });

  it("flags zero-width space and BOM", () => {
    expect(findForbiddenCharacters("한​글")).toEqual([{ issue: "Zero-width space U+200B", count: 1 }]);
    expect(findForbiddenCharacters("﻿한글")).toEqual([{ issue: "BOM/ZWNBSP U+FEFF", count: 1 }]);
  });

  it("flags private-use-area characters", () => {
    expect(findForbiddenCharacters("")).toEqual([
      { issue: "Private Use Area U+E000-U+F8FF", count: 1 },
    ]);
  });

  it("counts multiple occurrences", () => {
    expect(findForbiddenCharacters("���")).toEqual([{ issue: "U+FFFD REPLACEMENT CHARACTER", count: 3 }]);
  });
});

describe("collectStringLeaves", () => {
  it("flattens nested objects, skipping functions", () => {
    const obj = { a: "x", b: { c: "y" }, d: () => "not collected", e: ["z"] };
    expect(collectStringLeaves(obj).sort()).toEqual(["x", "y", "z"]);
  });
});

describe("Unicode source audit — code-backed participant content", () => {
  it("src/messages/participant/ko.ts has zero forbidden characters", () => {
    const leaves = collectStringLeaves(ko);
    const allFindings = leaves.flatMap((s) => findForbiddenCharacters(s));
    expect(allFindings).toEqual([]);
  });

  it("src/messages/participant/ja.ts has zero forbidden characters", () => {
    const leaves = collectStringLeaves(ja);
    const allFindings = leaves.flatMap((s) => findForbiddenCharacters(s));
    expect(allFindings).toEqual([]);
  });

  it("rrrvvnux studyWebAppText (ko) has zero forbidden characters", () => {
    const override = getStudyWebAppText("rrrvvnux", "ko");
    const leaves = collectStringLeaves(override);
    const allFindings = leaves.flatMap((s) => findForbiddenCharacters(s));
    expect(allFindings).toEqual([]);
  });

  it("rrrvvnux studyWebAppText (ja) has zero forbidden characters, including the preserved #45-style source text", () => {
    const override = getStudyWebAppText("rrrvvnux", "ja");
    const leaves = collectStringLeaves(override);
    const allFindings = leaves.flatMap((s) => findForbiddenCharacters(s));
    expect(allFindings).toEqual([]);
  });

  it("rrrvvnux guide page override (ko/ja) has zero forbidden characters", () => {
    const ko2 = getStudyGuidePageOverride("rrrvvnux", "ko");
    const ja2 = getStudyGuidePageOverride("rrrvvnux", "ja");
    const allFindings = [
      ...collectStringLeaves(ko2).flatMap((s) => findForbiddenCharacters(s)),
      ...collectStringLeaves(ja2).flatMap((s) => findForbiddenCharacters(s)),
    ];
    expect(allFindings).toEqual([]);
  });
});
