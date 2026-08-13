import { describe, it, expect } from "vitest";
import {
  computeGuideTemplateVariables,
  renderGuideTemplate,
  findUnknownTemplateVariables,
  DEFAULT_GUIDE_TEMPLATE_KO,
  DEFAULT_GUIDE_TEMPLATE_JA,
  defaultGuideTemplateFor,
} from "./guideTemplate";
import { computeGroupBounds } from "./groupBounds";

describe("computeGuideTemplateVariables — N=47 exact constraints", () => {
  it("matches the researcher-specified exact N=47 values", () => {
    const vars = computeGuideTemplateVariables(47, "ko");
    expect(vars.CARD_COUNT).toBe("47");
    expect(vars.MAX_CARDS_PER_GROUP).toBe("15");
    expect(vars.FIRST_FORBIDDEN_GROUP_SIZE).toBe("16");
    expect(vars.MIN_GROUPS).toBe("4");
    expect(vars.MAX_GROUPS).toBe("23");
    expect(vars.MIN_GROUP_BREAKDOWN).toBe("카드 2장으로 구성된 1개 묶음, 카드 15장으로 구성된 3개 묶음");
    expect(vars.MAX_GROUP_BREAKDOWN).toBe("카드 2장으로 구성된 22개 묶음, 카드 3장으로 구성된 1개 묶음");
  });

  it("KO and JA use identical numeric constraints for the same N", () => {
    const ko = computeGuideTemplateVariables(47, "ko");
    const ja = computeGuideTemplateVariables(47, "ja");
    expect(ja.CARD_COUNT).toBe(ko.CARD_COUNT);
    expect(ja.MAX_CARDS_PER_GROUP).toBe(ko.MAX_CARDS_PER_GROUP);
    expect(ja.FIRST_FORBIDDEN_GROUP_SIZE).toBe(ko.FIRST_FORBIDDEN_GROUP_SIZE);
    expect(ja.MIN_GROUPS).toBe(ko.MIN_GROUPS);
    expect(ja.MAX_GROUPS).toBe(ko.MAX_GROUPS);
  });

  it("JA breakdown text is translated, not identical prose, but same numbers", () => {
    const ja = computeGuideTemplateVariables(47, "ja");
    expect(ja.MIN_GROUP_BREAKDOWN).toBe("カード2枚で構成された1グループ、カード15枚で構成された3グループ");
    expect(ja.MAX_GROUP_BREAKDOWN).toBe("カード2枚で構成された22グループ、カード3枚で構成された1グループ");
  });
});

describe("computeGuideTemplateVariables — reuses computeGroupBounds for every N, no independent formula", () => {
  it.each([47, 48, 46, 30, 10])("N=%i matches computeGroupBounds exactly", (n) => {
    const bounds = computeGroupBounds(n);
    const vars = computeGuideTemplateVariables(n, "ko");
    expect(Number(vars.MAX_CARDS_PER_GROUP)).toBe(bounds.maxCardsPerGroup);
    expect(Number(vars.FIRST_FORBIDDEN_GROUP_SIZE)).toBe(bounds.maxCardsPerGroup + 1);
    expect(Number(vars.MIN_GROUPS)).toBe(bounds.minGroups);
    expect(Number(vars.MAX_GROUPS)).toBe(bounds.maxGroups);
  });

  it("N=48 exact", () => {
    const vars = computeGuideTemplateVariables(48, "ko");
    // maxCardsPerGroup = ceil(48/3)-1 = 16-1 = 15
    expect(vars.MAX_CARDS_PER_GROUP).toBe("15");
    expect(vars.FIRST_FORBIDDEN_GROUP_SIZE).toBe("16");
    expect(vars.MIN_GROUPS).toBe("4");
    expect(vars.MAX_GROUPS).toBe("24");
  });

  it("N=46 exact", () => {
    const vars = computeGuideTemplateVariables(46, "ko");
    // maxCardsPerGroup = ceil(46/3)-1 = 16-1 = 15
    expect(vars.MAX_CARDS_PER_GROUP).toBe("15");
    expect(vars.FIRST_FORBIDDEN_GROUP_SIZE).toBe("16");
    expect(vars.MIN_GROUPS).toBe("4");
    expect(vars.MAX_GROUPS).toBe("23");
  });

  it("N=30 exact", () => {
    const vars = computeGuideTemplateVariables(30, "ko");
    // maxCardsPerGroup = ceil(30/3)-1 = 10-1 = 9
    expect(vars.MAX_CARDS_PER_GROUP).toBe("9");
    expect(vars.FIRST_FORBIDDEN_GROUP_SIZE).toBe("10");
    expect(vars.MIN_GROUPS).toBe("4");
    expect(vars.MAX_GROUPS).toBe("15");
  });

  it("N=10 exact", () => {
    const vars = computeGuideTemplateVariables(10, "ko");
    // maxCardsPerGroup = max(2, ceil(10/3)-1) = max(2, 3) = 3
    expect(vars.MAX_CARDS_PER_GROUP).toBe("3");
    expect(vars.FIRST_FORBIDDEN_GROUP_SIZE).toBe("4");
    expect(vars.MIN_GROUPS).toBe("4");
    expect(vars.MAX_GROUPS).toBe("5");
  });
});

describe("renderGuideTemplate", () => {
  it("substitutes all known variables", () => {
    const vars = computeGuideTemplateVariables(47, "ko");
    const { rendered, unknownVariables } = renderGuideTemplate(
      "총 {{CARD_COUNT}}장, 최대 {{MAX_CARDS_PER_GROUP}}장, 최소 {{MIN_GROUPS}}개 묶음",
      vars
    );
    expect(rendered).toBe("총 47장, 최대 15장, 최소 4개 묶음");
    expect(unknownVariables).toEqual([]);
  });

  it("leaves unknown variables visibly unresolved rather than blanking them", () => {
    const vars = computeGuideTemplateVariables(47, "ko");
    const { rendered, unknownVariables } = renderGuideTemplate("{{CARD_COUNT}} and {{BOGUS_VAR}}", vars);
    expect(rendered).toBe("47 and {{BOGUS_VAR}}");
    expect(unknownVariables).toEqual(["BOGUS_VAR"]);
  });

  it("renders the full default KO template for N=47 with exact expected text", () => {
    const vars = computeGuideTemplateVariables(47, "ko");
    const { rendered, unknownVariables } = renderGuideTemplate(DEFAULT_GUIDE_TEMPLATE_KO, vars);
    expect(unknownVariables).toEqual([]);
    expect(rendered).toContain("전체 카드 47장을 하나의 묶음으로 분류할 수 없습니다");
    expect(rendered).toContain("16장 이상의 카드가 포함될 수 없습니다");
    expect(rendered).toContain("최소: 4개 묶음(카드 2장으로 구성된 1개 묶음, 카드 15장으로 구성된 3개 묶음)");
    expect(rendered).toContain("최대: 23개 묶음(카드 2장으로 구성된 22개 묶음, 카드 3장으로 구성된 1개 묶음)");
  });

  it("renders the full default JA template for N=47 with exact expected text", () => {
    const vars = computeGuideTemplateVariables(47, "ja");
    const { rendered, unknownVariables } = renderGuideTemplate(DEFAULT_GUIDE_TEMPLATE_JA, vars);
    expect(unknownVariables).toEqual([]);
    expect(rendered).toContain("47枚すべてのカードを1つのグループに分類することはできません");
    expect(rendered).toContain("16枚以上のステートメントカードを入れることはできません");
    expect(rendered).toContain("最少：4グループ（カード2枚で構成された1グループ、カード15枚で構成された3グループ）");
    expect(rendered).toContain("最多：23グループ（カード2枚で構成された22グループ、カード3枚で構成された1グループ）");
  });
});

describe("findUnknownTemplateVariables", () => {
  it("returns [] for a template using only known variables", () => {
    expect(findUnknownTemplateVariables(DEFAULT_GUIDE_TEMPLATE_KO)).toEqual([]);
    expect(findUnknownTemplateVariables(DEFAULT_GUIDE_TEMPLATE_JA)).toEqual([]);
  });

  it("flags an unknown variable without needing computed values", () => {
    expect(findUnknownTemplateVariables("{{TOTALLY_MADE_UP}}")).toEqual(["TOTALLY_MADE_UP"]);
  });

  it("flags multiple distinct unknown variables once each", () => {
    expect(findUnknownTemplateVariables("{{A}} {{B}} {{A}}")).toEqual(["A", "B"]);
  });

  it("does not flag plain text or legitimate punctuation", () => {
    expect(findUnknownTemplateVariables("① ※ ［ ］ <기타> 일반 텍스트")).toEqual([]);
  });
});

describe("defaultGuideTemplateFor", () => {
  it("returns the KO default for ko", () => {
    expect(defaultGuideTemplateFor("ko")).toBe(DEFAULT_GUIDE_TEMPLATE_KO);
  });

  it("returns the JA default for ja", () => {
    expect(defaultGuideTemplateFor("ja")).toBe(DEFAULT_GUIDE_TEMPLATE_JA);
  });
});
