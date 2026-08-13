import {
  computeGroupBounds,
  describeMaxGroupBreakdown,
  describeMaxGroupBreakdownJa,
  describeMinGroupBreakdown,
  describeMinGroupBreakdownJa,
} from "@/lib/groupBounds";

/**
 * Strict allowlist of template variables the admin-editable guide body may
 * reference. Anything outside this set is left visibly unresolved (never
 * silently blanked) so a typo is obvious to the admin, not the participant.
 */
export const GUIDE_TEMPLATE_VARIABLE_NAMES = [
  "CARD_COUNT",
  "MAX_CARDS_PER_GROUP",
  "FIRST_FORBIDDEN_GROUP_SIZE",
  "MIN_GROUPS",
  "MAX_GROUPS",
  "MIN_GROUP_BREAKDOWN",
  "MAX_GROUP_BREAKDOWN",
] as const;

export type GuideTemplateVariableName = (typeof GUIDE_TEMPLATE_VARIABLE_NAMES)[number];
export type GuideTemplateVariables = Record<GuideTemplateVariableName, string>;

/** Derives every supported template variable from the actual card count — reuses computeGroupBounds, never a second/conflicting formula. */
export function computeGuideTemplateVariables(
  cardCount: number,
  locale: "ko" | "ja"
): GuideTemplateVariables {
  const { maxCardsPerGroup, minGroups, maxGroups } = computeGroupBounds(cardCount);
  const minGroupBreakdown =
    locale === "ko"
      ? describeMinGroupBreakdown(cardCount, maxCardsPerGroup, minGroups)
      : describeMinGroupBreakdownJa(cardCount, maxCardsPerGroup, minGroups);
  const maxGroupBreakdown =
    locale === "ko"
      ? describeMaxGroupBreakdown(cardCount, maxGroups)
      : describeMaxGroupBreakdownJa(cardCount, maxGroups);

  return {
    CARD_COUNT: String(cardCount),
    MAX_CARDS_PER_GROUP: String(maxCardsPerGroup),
    FIRST_FORBIDDEN_GROUP_SIZE: String(maxCardsPerGroup + 1),
    MIN_GROUPS: String(minGroups),
    MAX_GROUPS: String(maxGroups),
    MIN_GROUP_BREAKDOWN: minGroupBreakdown,
    MAX_GROUP_BREAKDOWN: maxGroupBreakdown,
  };
}

const VARIABLE_PATTERN = /\{\{([A-Z_]+)\}\}/g;

export type GuideTemplateRenderResult = {
  rendered: string;
  unknownVariables: string[];
};

/** Substitutes {{KNOWN_VARIABLES}}; unknown ones are left as-is and reported, never silently dropped. */
export function renderGuideTemplate(
  template: string,
  variables: GuideTemplateVariables
): GuideTemplateRenderResult {
  const unknown = new Set<string>();
  const rendered = template.replace(VARIABLE_PATTERN, (match, name: string) => {
    if ((GUIDE_TEMPLATE_VARIABLE_NAMES as readonly string[]).includes(name)) {
      return variables[name as GuideTemplateVariableName];
    }
    unknown.add(name);
    return match;
  });
  return { rendered, unknownVariables: [...unknown] };
}

/** Scans a template for unknown variables without needing computed values — used for admin-side validation before save. */
export function findUnknownTemplateVariables(template: string): string[] {
  const unknown = new Set<string>();
  for (const match of template.matchAll(VARIABLE_PATTERN)) {
    const name = match[1];
    if (!(GUIDE_TEMPLATE_VARIABLE_NAMES as readonly string[]).includes(name)) {
      unknown.add(name);
    }
  }
  return [...unknown];
}

export const DEFAULT_GUIDE_TEMPLATE_KO = `※ 유사성 분류 작업 시, 다음의 5가지 지침을 반드시 준수해 주십시오.
① 하나의 묶음은 반드시 2장 이상의 카드로 구성되어야 합니다.
② 모든 카드를 하나의 묶음으로 만들 수는 없습니다. (전체 카드 {{CARD_COUNT}}장을 하나의 묶음으로 분류할 수 없습니다.)
③ 하나의 묶음에는 {{FIRST_FORBIDDEN_GROUP_SIZE}}장 이상의 카드가 포함될 수 없습니다. 이는 전체 {{CARD_COUNT}}장 카드의 1/3 이상이 하나의 묶음에 포함되는 것을 방지하기 위함입니다.
④ 남는 카드 간에 의미적 유사성(공통점)이 없다면, 이를 모두 <기타>라는 하나의 묶음으로 분류할 수 없습니다. 번거로우시더라도 다른 의미 있는 주제(묶음 제목)를 생각해 주세요. 서로 의미가 비슷하다고 판단되는 카드끼리만 같은 묶음으로 분류해 주세요.
⑤ 누락되거나 둘 이상의 묶음에 중복 배치되는 카드(진술문)가 없도록 유의해 주세요. {{CARD_COUNT}}장의 모든 카드는 각각 정확히 하나의 묶음에 반드시 포함되어야 합니다.
최소: {{MIN_GROUPS}}개 묶음({{MIN_GROUP_BREAKDOWN}})
최대: {{MAX_GROUPS}}개 묶음({{MAX_GROUP_BREAKDOWN}})`;

export const DEFAULT_GUIDE_TEMPLATE_JA = `※ 類似性に基づくカード分類課題を行う際には、以下の5つの手順を必ず守ってください。
① 各グループには、少なくとも2枚のステートメントカードを入れてください。
② すべてのステートメントカードを1つのグループにまとめることはできません。つまり、{{CARD_COUNT}}枚すべてのカードを1つのグループに分類することはできません。
③ 1つのグループに{{FIRST_FORBIDDEN_GROUP_SIZE}}枚以上のステートメントカードを入れることはできません。これは、全{{CARD_COUNT}}枚のカードの3分の1以上が1つのグループに集中することを避けるためです。
④ 残ったカードの間に意味上の十分な類似性や共通点がない場合、それらをまとめて「その他」という1つのグループに分類しないでください。別の意味のあるテーマやグループ名を考えてください。意味が類似していると判断したステートメントのみを同じグループに分類してください。
⑤ ステートメントカードの分類漏れや、複数のグループへの重複分類がないようにしてください。{{CARD_COUNT}}枚すべてのカードを、それぞれ必ず1つのグループにのみ分類してください。
最少：{{MIN_GROUPS}}グループ（{{MIN_GROUP_BREAKDOWN}}）
最多：{{MAX_GROUPS}}グループ（{{MAX_GROUP_BREAKDOWN}}）`;

export function defaultGuideTemplateFor(locale: "ko" | "ja"): string {
  return locale === "ko" ? DEFAULT_GUIDE_TEMPLATE_KO : DEFAULT_GUIDE_TEMPLATE_JA;
}
