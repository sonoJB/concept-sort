import { describe, it, expect } from "vitest";
import { getParticipantMessages } from "@/messages/participant";
import {
  getStudyWebAppText,
  getStudyGuidePageOverride,
  applyStudyWebAppTextOverride,
} from "./studyWebAppText";

const SLUG = "rrrvvnux";

describe("getStudyWebAppText — rrrvvnux workbook-exact strings", () => {
  it("KO title matches workbook exactly", () => {
    // Title itself lives on Project.title, not this override — but consent
    // heading, guide link text/description, and instructions are covered here.
    expect(getStudyWebAppText(SLUG, "ko")).not.toBeNull();
  });

  it("KO consent heading is exact", () => {
    expect(getStudyWebAppText(SLUG, "ko")!.consentHeading).toBe(
      "연구 참여 및 정보사용 동의서"
    );
  });

  it("JA consent heading is exact", () => {
    expect(getStudyWebAppText(SLUG, "ja")!.consentHeading).toBe(
      "研究参加および情報利用に関する同意書"
    );
  });

  it("KO guide link text is exact", () => {
    expect(getStudyWebAppText(SLUG, "ko")!.guideLinkText).toBe("[유사성 분류 방법 - 세부 지침]");
  });

  it("JA guide link text is exact", () => {
    expect(getStudyWebAppText(SLUG, "ja")!.guideLinkText).toBe(
      "［類似性分類の方法－詳細ガイドライン］"
    );
  });

  it("KO guide link description is exact", () => {
    expect(getStudyWebAppText(SLUG, "ko")!.guideLinkDescription).toBe(
      "클릭하시면 유사성 분류 방법(지침)이 활성화됩니다."
    );
  });

  it("JA guide link description is exact", () => {
    expect(getStudyWebAppText(SLUG, "ja")!.guideLinkDescription).toBe(
      "ここをクリックすると、類似性に基づくカード分類課題の詳しい手順を確認できます。"
    );
  });

  it("KO basic sorting instructions are exact", () => {
    expect(getStudyWebAppText(SLUG, "ko")!.guideInstructions).toBe(
      "왼쪽의 진술문 카드를 오른쪽의 묶음으로 드래그해서, 서로 의미가 비슷하다고 생각되는 진술문끼리 같은 묶음에 넣어 주세요. 각 카드는 반드시 하나의 묶음에만 배치할 수 있습니다. 묶음은 최소 4개에서 최대 23개까지 만들 수 있으며, 아래 버튼으로 직접 추가하거나 삭제할 수 있습니다. 47개의 모든 진술문 카드를 각각 하나의 묶음에 배치한 후 제출해 주세요. 자세한 지침은 위 링크를 클릭해 언제든 다시 확인할 수 있습니다."
    );
  });

  it("JA basic sorting instructions are exact", () => {
    expect(getStudyWebAppText(SLUG, "ja")!.guideInstructions).toBe(
      "左側にある各ステートメントカードを、右側のグループにドラッグしてください。意味や内容が似ていると思うステートメントは、同じグループにまとめてください。それぞれのステートメントカードは、必ず1つのグループだけに分類してください。グループは最低4つ、最大23個まで作成でき、下のボタンを使ってグループを追加したり削除したりできます。47枚すべてのステートメントカードを、それぞれ1つのグループに分類したら、回答を送信してください。詳しい説明は、上のリンクをクリックするといつでも確認できます。"
    );
  });

  it("returns null for a project slug with no override", () => {
    expect(getStudyWebAppText("some-other-project", "ko")).toBeNull();
    expect(getStudyWebAppText("some-other-project", "ja")).toBeNull();
  });
});

describe("getStudyGuidePageOverride — title only (body now lives in Project.guideTemplateKo/Ja)", () => {
  it("KO guide title is exact", () => {
    expect(getStudyGuidePageOverride(SLUG, "ko")!.title).toBe("[유사성 분류 방법 - 세부 지침]");
  });

  it("JA guide title is exact", () => {
    expect(getStudyGuidePageOverride(SLUG, "ja")!.title).toBe(
      "［類似性分類の方法－詳細ガイドライン］"
    );
  });

  it("returns null for a project slug with no override", () => {
    expect(getStudyGuidePageOverride("some-other-project", "ko")).toBeNull();
  });
});

describe("applyStudyWebAppTextOverride", () => {
  it("overrides consentStep.heading, guide.linkText, guide.linkDescription, guide.instructions for rrrvvnux/ko", () => {
    const merged = applyStudyWebAppTextOverride(getParticipantMessages("ko"), SLUG, "ko");
    expect(merged.consentStep.heading).toBe("연구 참여 및 정보사용 동의서");
    expect(merged.guide.linkText).toBe("[유사성 분류 방법 - 세부 지침]");
    expect(merged.guide.linkDescription).toBe("클릭하시면 유사성 분류 방법(지침)이 활성화됩니다.");
    // Instructions is a fixed literal for this study — dynamic minGroups/maxGroups
    // args are ignored (numbers are already baked into the workbook-exact text).
    expect(merged.guide.instructions(1, 2)).toContain("47개의 모든 진술문 카드");
  });

  it("overrides the same fields for rrrvvnux/ja", () => {
    const merged = applyStudyWebAppTextOverride(getParticipantMessages("ja"), SLUG, "ja");
    expect(merged.consentStep.heading).toBe("研究参加および情報利用に関する同意書");
    expect(merged.guide.linkText).toBe("［類似性分類の方法－詳細ガイドライン］");
  });

  it("leaves an unrelated project's messages completely untouched", () => {
    const base = getParticipantMessages("ko");
    const merged = applyStudyWebAppTextOverride(base, "some-other-project", "ko");
    expect(merged).toBe(base);
  });

  it("no Korean fallback leaks into the JA merged messages", () => {
    const merged = applyStudyWebAppTextOverride(getParticipantMessages("ja"), SLUG, "ja");
    expect(merged.consentStep.heading).not.toMatch(/[가-힣]/);
    expect(merged.guide.linkText).not.toMatch(/[가-힣]/);
    expect(merged.guide.linkDescription).not.toMatch(/[가-힣]/);
    expect(merged.guide.instructions(1, 2)).not.toMatch(/[가-힣]/);
  });
});
