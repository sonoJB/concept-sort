import type { MessageShape } from "@/messages/participant/types";

type Locale = "ko" | "ja";

type GuidePageOverride = {
  title: string;
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
