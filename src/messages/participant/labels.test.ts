import { describe, it, expect } from "vitest";
import { ko } from "./ko";
import { ja } from "./ja";

describe("participant-facing field labels — exact wording", () => {
  it("Korean name label is exactly 이름", () => {
    expect(ko.nameStep.label).toBe("이름");
  });

  it("Japanese name label is exactly 名前", () => {
    expect(ja.nameStep.label).toBe("名前");
  });

  it("Korean phone label is exactly 스마트폰 번호", () => {
    expect(ko.demographics.phoneLabel).toBe("스마트폰 번호");
  });

  it("Japanese phone label is exactly 携帯電話番号の下4桁（本人識別用）", () => {
    expect(ja.demographics.phoneLabel).toBe("携帯電話番号の下4桁（本人識別用）");
  });

  it("Korean phone label/placeholder are unchanged by the Japan-only last-4-digits change", () => {
    expect(ko.demographics.phoneLabel).toBe("스마트폰 번호");
    expect(ko.demographics.phonePlaceholder).toBe("예: 010-1234-5678");
    expect(ko.demographics.phoneHelperText).toBe("");
  });

  it("Japanese phone helper text explains 本人識別 (participant identification), never 本人確認 (identity verification) or a uniqueness guarantee", () => {
    expect(ja.demographics.phoneHelperText).toContain("本人識別");
    expect(ja.demographics.phoneHelperText).not.toContain("本人確認");
    expect(ja.demographics.phoneHelperText).not.toContain("一意");
    expect(ja.demographics.phoneHelperText).not.toContain("ユニーク");
  });

  it("Japanese phone placeholder shows a 4-digit example, never a full phone number shape", () => {
    expect(ja.demographics.phonePlaceholder).toBe("例：1234");
    expect(ja.demographics.phonePlaceholder).not.toMatch(/\d{2,4}-\d{2,4}-\d{3,4}/);
  });

  it("Japanese PHONE_INVALID validation message matches the researcher-specified wording exactly", () => {
    expect(ja.errors.PHONE_INVALID).toBe("携帯電話番号の下4桁を数字4桁で入力してください。");
  });

  it("Korean messages no longer contain the old name-field wording", () => {
    expect(ko.nameStep.label).not.toContain("닉네임");
    expect(ko.errors.PARTICIPANT_NAME_REQUIRED).not.toContain("닉네임");
  });

  it("Japanese messages no longer contain the old name-field wording", () => {
    expect(ja.nameStep.label).not.toContain("ニックネーム");
    expect(ja.errors.PARTICIPANT_NAME_REQUIRED).not.toContain("ニックネーム");
  });

  it("Korean messages no longer contain the old phone-field wording", () => {
    expect(ko.demographics.phoneLabel).not.toContain("기프티콘");
    expect(ko.demographics.phoneLabel).not.toContain("답례품");
    expect(ko.errors.PHONE_REQUIRED).not.toContain("답례품");
  });

  it("Japanese messages no longer contain the old phone-field wording", () => {
    expect(ja.demographics.phoneLabel).not.toContain("デジタルギフト");
    expect(ja.demographics.phoneLabel).not.toContain("謝礼");
    expect(ja.errors.PHONE_REQUIRED).not.toContain("謝礼");
  });
});
