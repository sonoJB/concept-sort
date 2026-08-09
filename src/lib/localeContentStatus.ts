import { resolveEffectiveConsentKo } from "@/lib/consent";
import { detectDisallowedContact, detectPlaceholder } from "@/lib/jaContentGuard";

export type Locale = "ko" | "ja";

export const JA_STATUSES = ["MISSING", "DRAFT", "REVIEWING", "APPROVED"] as const;
export type JaStatus = (typeof JA_STATUSES)[number];

export function isValidJaStatus(value: unknown): value is JaStatus {
  return typeof value === "string" && (JA_STATUSES as readonly string[]).includes(value);
}

export type StatusStatement = {
  order: number;
  text: string;
  textJa: string | null;
  jaStatus: string;
};

export type StatusProject = {
  title: string;
  prompt: string;
  consentKo: string | null;
  titleJa: string | null;
  promptJa: string | null;
  consentJa: string | null;
  legacyConsentFallbackEnabled: boolean;
  koPreviewConfirmedAt: Date | null;
  jaPreviewConfirmedAt: Date | null;
};

export type LocaleContentStatus = {
  locale: Locale;
  titleComplete: boolean;
  promptComplete: boolean;
  consentComplete: boolean;
  consentUsesLegacyFallback: boolean;
  consentHasPlaceholder: boolean;
  consentHasDisallowedContact: boolean;
  totalStatements: number;
  completedStatements: number;
  approvedStatements: number;
  missingStatementNumbers: number[];
  notApprovedStatementNumbers: number[];
  previewConfirmed: boolean;
  ready: boolean;
  reasons: string[];
};

/**
 * Computes readiness for one locale. Japanese fields never fall back to
 * Korean fields — a null titleJa/promptJa/consentJa/textJa is simply
 * incomplete, never filled in from the Korean equivalent.
 */
export function computeLocaleContentStatus(
  locale: Locale,
  project: StatusProject,
  statements: StatusStatement[],
  options?: { ignorePreviewConfirmation?: boolean }
): LocaleContentStatus {
  const reasons: string[] = [];
  const ignorePreview = options?.ignorePreviewConfirmation ?? false;

  if (locale === "ko") {
    const titleComplete = Boolean(project.title?.trim());
    const promptComplete = Boolean(project.prompt?.trim());
    const effectiveConsent = resolveEffectiveConsentKo(project);
    const consentComplete = Boolean(effectiveConsent);
    const consentUsesLegacyFallback =
      !project.consentKo?.trim() && project.legacyConsentFallbackEnabled;

    const missingStatementNumbers = statements
      .filter((s) => !s.text?.trim())
      .map((s) => s.order + 1);
    const completedStatements = statements.length - missingStatementNumbers.length;

    const previewConfirmed = Boolean(project.koPreviewConfirmedAt);

    if (!titleComplete) reasons.push("연구 제목이 비어 있습니다.");
    if (!promptComplete) reasons.push("연구 소개 및 참여 안내가 비어 있습니다.");
    if (!consentComplete)
      reasons.push(
        "동의서가 비어 있고, 기존 하드코딩 동의서로 대체할 수 있는 프로젝트도 아닙니다."
      );
    if (missingStatementNumbers.length > 0)
      reasons.push(`한국어 진술문이 비어 있는 항목이 있습니다: ${missingStatementNumbers.join(", ")}번`);
    if (!ignorePreview && !previewConfirmed)
      reasons.push("한국어 미리보기 확인이 아직 이루어지지 않았습니다.");

    const ready =
      titleComplete &&
      promptComplete &&
      consentComplete &&
      missingStatementNumbers.length === 0 &&
      (ignorePreview || previewConfirmed);

    return {
      locale,
      titleComplete,
      promptComplete,
      consentComplete,
      consentUsesLegacyFallback,
      consentHasPlaceholder: false,
      consentHasDisallowedContact: false,
      totalStatements: statements.length,
      completedStatements,
      approvedStatements: completedStatements,
      missingStatementNumbers,
      notApprovedStatementNumbers: [],
      previewConfirmed,
      ready,
      reasons,
    };
  }

  // ja
  const titleComplete = Boolean(project.titleJa?.trim());
  const promptComplete = Boolean(project.promptJa?.trim());
  const consentComplete = Boolean(project.consentJa?.trim());
  const placeholder = detectPlaceholder(project.consentJa);
  const contact = detectDisallowedContact(project.consentJa);

  const missingStatementNumbers = statements
    .filter((s) => !s.textJa?.trim())
    .map((s) => s.order + 1);
  const notApprovedStatementNumbers = statements
    .filter((s) => s.jaStatus !== "APPROVED")
    .map((s) => s.order + 1);
  const completedStatements = statements.length - missingStatementNumbers.length;
  const approvedStatements = statements.length - notApprovedStatementNumbers.length;

  const previewConfirmed = Boolean(project.jaPreviewConfirmedAt);

  if (!titleComplete) reasons.push("研究タイトルが入力されていません。 (일본어 제목 미입력)");
  if (!promptComplete)
    reasons.push("研究の紹介および参加案内が入力されていません。 (일본어 안내문 미입력)");
  if (!consentComplete)
    reasons.push("同意書が入力されていません。 (일본어 동의서 미입력, 한국어에서 자동 대체되지 않음)");
  if (placeholder.found)
    reasons.push(
      `동의서에 미확정 템플릿 표현이 남아 있습니다: ${placeholder.violations
        .map((v) => `${v.pattern}(${v.matchedText})`)
        .join(", ")}`
    );
  if (contact.found)
    reasons.push(
      `동의서에 공개 금지 연락처로 의심되는 내용이 있습니다: ${contact.violations
        .map((v) => `${v.pattern}(${v.matchedText})`)
        .join(", ")}`
    );
  if (missingStatementNumbers.length > 0)
    reasons.push(`일본어 진술문이 비어 있는 항목이 있습니다: ${missingStatementNumbers.join(", ")}番`);
  if (notApprovedStatementNumbers.length > 0)
    reasons.push(`승인되지 않은 일본어 진술문이 있습니다: ${notApprovedStatementNumbers.join(", ")}番`);
  if (!ignorePreview && !previewConfirmed)
    reasons.push("일본어 미리보기 확인이 아직 이루어지지 않았습니다.");

  const ready =
    titleComplete &&
    promptComplete &&
    consentComplete &&
    !placeholder.found &&
    !contact.found &&
    missingStatementNumbers.length === 0 &&
    notApprovedStatementNumbers.length === 0 &&
    (ignorePreview || previewConfirmed);

  return {
    locale,
    titleComplete,
    promptComplete,
    consentComplete,
    consentUsesLegacyFallback: false,
    consentHasPlaceholder: placeholder.found,
    consentHasDisallowedContact: contact.found,
    totalStatements: statements.length,
    completedStatements,
    approvedStatements,
    missingStatementNumbers,
    notApprovedStatementNumbers,
    previewConfirmed,
    ready,
    reasons,
  };
}

export type OperatingState = "DRAFT" | "KO_ONLY" | "JA_ONLY" | "BOTH";

/** Computed only — never persisted (no operatingMode column exists). */
export function computeOperatingState(
  koreanEnabled: boolean,
  japaneseEnabled: boolean
): OperatingState {
  if (koreanEnabled && japaneseEnabled) return "BOTH";
  if (koreanEnabled) return "KO_ONLY";
  if (japaneseEnabled) return "JA_ONLY";
  return "DRAFT";
}
