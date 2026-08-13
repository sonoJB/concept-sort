import type { ErrorCode } from "@/lib/errorCodes";

/**
 * Every participant-facing system-UI string, keyed by locale. This is a
 * hand-rolled dictionary (no external i18n library) — `ko.ts` and `ja.ts`
 * both declare `satisfies MessageShape`, so a missing or extra key in
 * either file is a TypeScript compile error, not a silent runtime gap.
 */
export type MessageShape = {
  common: {
    next: string;
    back: string;
    submit: string;
    submitting: string;
  };
  countryStep: {
    titleKo: string;
    titleJa: string;
    subtitleEn: string;
    korea: string;
    japan: string;
    ariaGroupLabel: string;
  };
  nameStep: {
    label: string;
    placeholder: string;
  };
  consentStep: {
    heading: string;
    questionLabel: string;
    agree: string;
    disagree: string;
    signatureLabel: string;
  };
  declinedStep: {
    heading: string;
    body: string;
  };
  demographics: {
    heading: string;
    genderLabel: string;
    male: string;
    female: string;
    ageLabel: string;
    schoolLevelLabel: string;
    middle: string;
    high: string;
    gradeLabel: string;
    grade1: string;
    grade2: string;
    grade3: string;
    phoneLabel: string;
    phonePlaceholder: string;
    submitLabel: string;
  };
  guide: {
    linkText: string;
    linkDescription: string;
    instructions: (minGroups: number, maxGroups: number) => string;
  };
  videoGuide: {
    linkText: string;
  };
  sorting: {
    unassignedLabel: (count: number) => string;
    groupsLabel: (current: number, min: number, max: number) => string;
    groupNamePlaceholder: (index: number) => string;
    cardCount: (count: number) => string;
    addGroup: string;
    deleteGroup: string;
    scrollHint: string;
  };
  submitted: {
    heading: string;
  };
  previewBanner: {
    label: string;
    confirmButton: string;
    backToAdmin: string;
  };
  blocked: {
    heading: string;
  };
  errors: {
    [K in ErrorCode]: string | ((n: number) => string);
  };
};
