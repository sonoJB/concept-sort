import type { MessageShape } from "@/messages/participant/types";

type Locale = "ko" | "ja";

type GuidePageOverride = {
  title: string;
  intro: string;
  rule1: string;
  rule2: string;
  rule3: string;
  rule4: string;
  rule5: string;
  minBundleLine: string;
  maxBundleLine: string;
};

type StudyWebAppTextOverride = {
  guideLinkText: string;
  guideLinkDescription: string;
  guideInstructions: string;
  consentHeading: string;
  guidePage: GuidePageOverride;
};

/**
 * Project-scoped participant-facing text overrides. Keyed by Project.slug —
 * only slugs listed here deviate from the global src/messages/participant
 * defaults and src/app/p/[slug]/guide/page.tsx's generic dynamic template.
 * Source: Japan_Korea_Cyberbullying_WebApp_KR_JP_260813.xlsx (WebApp Text
 * sheet), fixed for this study's exact 47-statement set — deliberately
 * literal (not recomputed from statementCount) so the guide page matches the
 * source workbook byte-for-byte regardless of future statement-count changes
 * to other projects sharing the generic template.
 */
const STUDY_WEBAPP_TEXT: Record<string, Record<Locale, StudyWebAppTextOverride>> = {
  rrrvvnux: {
    ko: {
      guideLinkText: "[유사성 분류 방법 안내문]",
      guideLinkDescription: "클릭하시면 유사성 분류 방법(지침)이 활성화됩니다.",
      guideInstructions:
        "왼쪽의 진술문 카드를 오른쪽의 묶음으로 드래그해서, 서로 의미가 비슷하다고 생각되는 진술문끼리 같은 묶음에 넣어 주세요. 각 카드는 반드시 하나의 묶음에만 배치할 수 있습니다. 묶음은 최소 4개에서 최대 23개까지 만들 수 있으며, 아래 버튼으로 직접 추가하거나 삭제할 수 있습니다. 47개의 모든 진술문 카드를 각각 하나의 묶음에 배치한 후 제출해 주세요. 자세한 지침은 위 링크를 클릭해 언제든 다시 확인할 수 있습니다.",
      consentHeading: "연구 참여 및 정보사용 동의서",
      guidePage: {
        title: "[유사성 분류 방법 안내문]",
        intro: "※ 유사성 분류 작업 시, 다음의 5가지 지침을 반드시 준수해 주십시오.",
        rule1: "① 하나의 묶음은 반드시 2장 이상의 카드로 구성되어야 합니다.",
        rule2:
          "② 모든 카드를 하나의 묶음으로 만들 수는 없습니다. (전체 카드 47장을 하나의 묶음으로 분류할 수 없습니다.)",
        rule3:
          "③ 하나의 묶음에는 16장 이상의 카드가 포함될 수 없습니다. 이는 전체 47장 카드의 1/3 이상이 하나의 묶음에 포함되는 것을 방지하기 위함입니다.",
        rule4:
          "④ 남는 카드 간에 의미적 유사성(공통점)이 없다면, 이를 모두 <기타>라는 하나의 묶음으로 분류할 수 없습니다. 번거로우시더라도 다른 의미 있는 주제(묶음 제목)를 생각해 주세요. 서로 의미가 비슷하다고 판단되는 카드끼리만 같은 묶음으로 분류해 주세요.",
        rule5:
          "⑤ 누락되거나 둘 이상의 묶음에 중복 배치되는 카드(진술문)가 없도록 유의해 주세요. 47장의 모든 카드는 각각 정확히 하나의 묶음에 반드시 포함되어야 합니다.",
        minBundleLine: "최소: 4개 묶음(카드 2장으로 구성된 1개 묶음, 카드 15장으로 구성된 3개 묶음)",
        maxBundleLine: "최대: 23개 묶음(카드 2장으로 구성된 22개 묶음, 카드 3장으로 구성된 1개 묶음)",
      },
    },
    ja: {
      guideLinkText: "［類似性に基づくカード分類課題の実施方法］",
      guideLinkDescription: "ここをクリックすると、類似性に基づくカード分類課題の詳しい手順を確認できます。",
      guideInstructions:
        "左側にある各ステートメントカードを、右側のグループにドラッグしてください。意味や内容が似ていると思うステートメントは、同じグループにまとめてください。それぞれのステートメントカードは、必ず1つのグループだけに分類してください。グループは最低4つ、最大23個まで作成でき、下のボタンを使ってグループを追加したり削除したりできます。47枚すべてのステートメントカードを、それぞれ1つのグループに分類したら、回答を送信してください。詳しい説明は、上のリンクをクリックするといつでも確認できます。",
      consentHeading: "研究参加および情報利用に関する同意書",
      guidePage: {
        title: "［類似性に基づくカード分類課題の実施方法］",
        intro: "※ 類似性に基づくカード分類課題を行う際には、以下の5つの手順を必ず守ってください。",
        rule1: "① 各グループには、少なくとも2枚のステートメントカードを入れてください。",
        rule2:
          "② すべてのステートメントカードを1つのグループにまとめることはできません。つまり、47枚すべてのカードを1つのグループに分類することはできません。",
        rule3:
          "③ 1つのグループに16枚以上のステートメントカードを入れることはできません。これは、全47枚のカードの3分の1以上が1つのグループに集中することを避けるためです。",
        rule4:
          "④ 残ったカードの間に意味上の十分な類似性や共通点がない場合、それらをまとめて「その他」という1つのグループに分類しないでください。別の意味のあるテーマやグループ名を考えてください。意味が類似していると判断したステートメントのみを同じグループに分類してください。",
        rule5:
          "⑤ ステートメントカードの分類漏れや、複数のグループへの重複分類がないようにしてください。47枚すべてのカードを、それぞれ必ず1つのグループにのみ分類してください。",
        minBundleLine: "最少：4グループ（2枚のカードからなる1グループと、15枚のカードからなる3グループ）",
        maxBundleLine: "最多：23グループ（2枚のカードからなる22グループと、3枚のカードからなる1グループ）",
      },
    },
  },
};

export function getStudyWebAppText(slug: string, locale: Locale): StudyWebAppTextOverride | null {
  return STUDY_WEBAPP_TEXT[slug]?.[locale] ?? null;
}

export function getStudyGuidePageOverride(slug: string, locale: Locale): GuidePageOverride | null {
  return STUDY_WEBAPP_TEXT[slug]?.[locale]?.guidePage ?? null;
}

/** Merges a project-scoped override onto the global participant MessageShape; returns `base` unchanged for any slug with no override. */
export function applyStudyWebAppTextOverride(
  base: MessageShape,
  slug: string,
  locale: Locale
): MessageShape {
  const override = getStudyWebAppText(slug, locale);
  if (!override) return base;
  return {
    ...base,
    consentStep: { ...base.consentStep, heading: override.consentHeading },
    guide: {
      ...base.guide,
      linkText: override.guideLinkText,
      linkDescription: override.guideLinkDescription,
      instructions: () => override.guideInstructions,
    },
  };
}
