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
    expect(getStudyWebAppText(SLUG, "ko")!.guideLinkText).toBe("[유사성 분류 방법 안내문]");
  });

  it("JA guide link text is exact", () => {
    expect(getStudyWebAppText(SLUG, "ja")!.guideLinkText).toBe(
      "［類似性に基づくカード分類課題の実施方法］"
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

describe("getStudyGuidePageOverride — 5 rules + min/max, exact", () => {
  it("KO guide title is exact", () => {
    expect(getStudyGuidePageOverride(SLUG, "ko")!.title).toBe("[유사성 분류 방법 안내문]");
  });

  it("JA guide title is exact", () => {
    expect(getStudyGuidePageOverride(SLUG, "ja")!.title).toBe(
      "［類似性に基づくカード分類課題の実施方法］"
    );
  });

  it("KO guide intro (5-rules header) is exact", () => {
    expect(getStudyGuidePageOverride(SLUG, "ko")!.intro).toBe(
      "※ 유사성 분류 작업 시, 다음의 5가지 지침을 반드시 준수해 주십시오."
    );
  });

  it("JA guide intro (5-rules header) is exact", () => {
    expect(getStudyGuidePageOverride(SLUG, "ja")!.intro).toBe(
      "※ 類似性に基づくカード分類課題を行う際には、以下の5つの手順を必ず守ってください。"
    );
  });

  it("all 5 KO rules are exact", () => {
    const o = getStudyGuidePageOverride(SLUG, "ko")!;
    expect(o.rule1).toBe("① 하나의 묶음은 반드시 2장 이상의 카드로 구성되어야 합니다.");
    expect(o.rule2).toBe(
      "② 모든 카드를 하나의 묶음으로 만들 수는 없습니다. (전체 카드 47장을 하나의 묶음으로 분류할 수 없습니다.)"
    );
    expect(o.rule3).toBe(
      "③ 하나의 묶음에는 16장 이상의 카드가 포함될 수 없습니다. 이는 전체 47장 카드의 1/3 이상이 하나의 묶음에 포함되는 것을 방지하기 위함입니다."
    );
    expect(o.rule4).toBe(
      "④ 남는 카드 간에 의미적 유사성(공통점)이 없다면, 이를 모두 <기타>라는 하나의 묶음으로 분류할 수 없습니다. 번거로우시더라도 다른 의미 있는 주제(묶음 제목)를 생각해 주세요. 서로 의미가 비슷하다고 판단되는 카드끼리만 같은 묶음으로 분류해 주세요."
    );
    expect(o.rule5).toBe(
      "⑤ 누락되거나 둘 이상의 묶음에 중복 배치되는 카드(진술문)가 없도록 유의해 주세요. 47장의 모든 카드는 각각 정확히 하나의 묶음에 반드시 포함되어야 합니다."
    );
  });

  it("all 5 JA rules are exact", () => {
    const o = getStudyGuidePageOverride(SLUG, "ja")!;
    expect(o.rule1).toBe("① 各グループには、少なくとも2枚のステートメントカードを入れてください。");
    expect(o.rule2).toBe(
      "② すべてのステートメントカードを1つのグループにまとめることはできません。つまり、47枚すべてのカードを1つのグループに分類することはできません。"
    );
    expect(o.rule3).toBe(
      "③ 1つのグループに16枚以上のステートメントカードを入れることはできません。これは、全47枚のカードの3分の1以上が1つのグループに集中することを避けるためです。"
    );
    expect(o.rule4).toBe(
      "④ 残ったカードの間に意味上の十分な類似性や共通点がない場合、それらをまとめて「その他」という1つのグループに分類しないでください。別の意味のあるテーマやグループ名を考えてください。意味が類似していると判断したステートメントのみを同じグループに分類してください。"
    );
    expect(o.rule5).toBe(
      "⑤ ステートメントカードの分類漏れや、複数のグループへの重複分類がないようにしてください。47枚すべてのカードを、それぞれ必ず1つのグループにのみ分類してください。"
    );
  });

  it("KO min/max bundle lines are exact", () => {
    const o = getStudyGuidePageOverride(SLUG, "ko")!;
    expect(o.minBundleLine).toBe("최소: 4개 묶음(카드 2장으로 구성된 1개 묶음, 카드 15장으로 구성된 3개 묶음)");
    expect(o.maxBundleLine).toBe("최대: 23개 묶음(카드 2장으로 구성된 22개 묶음, 카드 3장으로 구성된 1개 묶음)");
  });

  it("JA min/max bundle lines are exact", () => {
    const o = getStudyGuidePageOverride(SLUG, "ja")!;
    expect(o.minBundleLine).toBe("最少：4グループ（2枚のカードからなる1グループと、15枚のカードからなる3グループ）");
    expect(o.maxBundleLine).toBe("最多：23グループ（2枚のカードからなる22グループと、3枚のカードからなる1グループ）");
  });

  it("returns null for a project slug with no override", () => {
    expect(getStudyGuidePageOverride("some-other-project", "ko")).toBeNull();
  });
});

describe("applyStudyWebAppTextOverride", () => {
  it("overrides consentStep.heading, guide.linkText, guide.linkDescription, guide.instructions for rrrvvnux/ko", () => {
    const merged = applyStudyWebAppTextOverride(getParticipantMessages("ko"), SLUG, "ko");
    expect(merged.consentStep.heading).toBe("연구 참여 및 정보사용 동의서");
    expect(merged.guide.linkText).toBe("[유사성 분류 방법 안내문]");
    expect(merged.guide.linkDescription).toBe("클릭하시면 유사성 분류 방법(지침)이 활성화됩니다.");
    // Instructions is a fixed literal for this study — dynamic minGroups/maxGroups
    // args are ignored (numbers are already baked into the workbook-exact text).
    expect(merged.guide.instructions(1, 2)).toContain("47개의 모든 진술문 카드");
  });

  it("overrides the same fields for rrrvvnux/ja", () => {
    const merged = applyStudyWebAppTextOverride(getParticipantMessages("ja"), SLUG, "ja");
    expect(merged.consentStep.heading).toBe("研究参加および情報利用に関する同意書");
    expect(merged.guide.linkText).toBe("［類似性に基づくカード分類課題の実施方法］");
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
