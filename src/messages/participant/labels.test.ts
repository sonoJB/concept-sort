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

  it("Japanese phone label is exactly スマートフォン番号", () => {
    expect(ja.demographics.phoneLabel).toBe("スマートフォン番号");
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
