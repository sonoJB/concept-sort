/**
 * Legacy Korean consent body for the original cyberbullying-perception study.
 * Only projects with Project.legacyConsentFallbackEnabled=true (the single
 * pre-existing project) may fall back to this text when Project.consentKo is
 * empty. New projects must author their own consentKo — this constant must
 * never be used as a default for them.
 */
export const LEGACY_CONSENT_BODY_KO = `본 연구는 청소년이 인식한 사이버폭력 특징에 대한 개념을 탐색하는 연구입니다. 본 연구의 참여에 앞서 연구에 대한 설명과 동의서를 읽어 보십시오. 귀하의 서명은 연구에 대한 설명을 읽었으며 연구 참여에 동의하였다는 것을 의미합니다.

1. 연구 목적
본 연구의 목적은 청소년이 인식한 사이버폭력 특징의 개념을 체계화하고 분석하며 이를 활용하는 방안을 제안하는 데 있습니다. 도출된 사이버폭력 특징의 구성요소는 향후 한-일 양국 간 인식 비교 연구의 이론적 기초 자료로 활용될 예정입니다.

2. 연구 참여 내용
본 연구진은 사전 인터뷰를 통해 청소년이 인식한 사이버폭력 특징에 대한 개념을 진술문 형태로 추출하였고 이를 유사성 분류 카드(진술문)로 제작하였습니다.

3. 개인정보와 비밀 보장
본 연구진은 귀하의 개인정보 보호를 포함한 연구윤리를 준수할 것입니다. 본 연구의 참여로 수집되는 개인정보는 성명과 성별, 소속, 연령, 연락처 등의 개인식별 정보이며, 이는 연구목적을 위해 코드화하여 처리하고 통계적으로 수치화됩니다. 연구에서 얻어진 개인정보가 학회지나 학회에 활용될 때 귀하의 이름과 개인식별 정보는 사용하지 않습니다.

2026. 08.
이화여자대학교 오인수 교수 연구팀`;

/**
 * Applies the finalized consentKo fallback rule: an explicit consentKo
 * always wins; the legacy body only fills in for the one pre-existing
 * project that has legacyConsentFallbackEnabled=true. New projects with no
 * consentKo and no legacy flag get null (treated as "not ready").
 */
export function resolveEffectiveConsentKo(project: {
  consentKo: string | null;
  legacyConsentFallbackEnabled: boolean;
}): string | null {
  const trimmed = project.consentKo?.trim();
  if (trimmed) return project.consentKo as string;
  if (project.legacyConsentFallbackEnabled) return LEGACY_CONSENT_BODY_KO;
  return null;
}

/**
 * The only string allowed to identify the Japanese-side responsible
 * researcher in participant-facing content. No email, phone, address, or
 * detailed affiliation may be added alongside it.
 */
export const JA_RESPONSIBLE_PARTY_NOTICE = `日本側研究責任者・お問い合わせ先：
Tomoyuki Kanetsuna, Ph.D 研究室`;
