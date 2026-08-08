"use client";

/** Thin fetch wrapper for the analysis API namespace — Authorization: Bearer only, never a query-string token. */
async function analysisFetch(adminToken: string, path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
  });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

export function analysisApi(slug: string, adminToken: string) {
  const base = `/api/projects/${slug}/analysis`;
  return {
    eligibility: (scope: string) => analysisFetch(adminToken, `${base}/eligibility?scope=${scope}`),
    inputSummary: (scope: string) => analysisFetch(adminToken, `${base}/input-summary?scope=${scope}`),
    listRuns: (scope?: string) => analysisFetch(adminToken, `${base}/runs${scope ? `?scope=${scope}` : ""}`),
    createRun: (scope: string) => analysisFetch(adminToken, `${base}/runs`, { method: "POST", body: JSON.stringify({ scope }) }),
    getRun: (runId: string) => analysisFetch(adminToken, `${base}/runs/${runId}`),
    exportData: (runId: string, lang: "ko" | "ja", interpretationId?: string | null) =>
      analysisFetch(
        adminToken,
        `${base}/runs/${runId}/export-data?lang=${lang}${interpretationId ? `&interpretationId=${interpretationId}` : ""}`
      ),
    listInterpretations: (runId: string) => analysisFetch(adminToken, `${base}/runs/${runId}/interpretations`),
    createInterpretation: (runId: string, selectedClusterCount: number, previousInterpretationId?: string | null) =>
      analysisFetch(adminToken, `${base}/runs/${runId}/interpretations`, {
        method: "POST",
        body: JSON.stringify({ selectedClusterCount, previousInterpretationId }),
      }),
    patchInterpretation: (interpretationId: string, data: Record<string, unknown>) =>
      analysisFetch(adminToken, `${base}/interpretations/${interpretationId}`, { method: "PATCH", body: JSON.stringify(data) }),
    saveLabel: (interpretationId: string, clusterIndex: number, language: "ko" | "ja", label: string, memo?: string) =>
      analysisFetch(adminToken, `${base}/interpretations/${interpretationId}/labels`, {
        method: "POST",
        body: JSON.stringify({ clusterIndex, language, label, memo }),
      }),
  };
}

export const EXPORT_BLOCK_MESSAGES: Record<string, string> = {
  RUN_NOT_COMPLETED: "이 실행은 아직 완료되지 않았거나 실패했습니다.",
  NUMERIC_STALE: "현재 응답 데이터가 이 분석 실행 시점과 달라 결과를 다시 계산해야 합니다.",
  CONTENT_STALE: "선택한 언어의 진술문 내용이 이 실행 이후 변경되었습니다.",
  PARAMETERS_SUPERSEDED: "현재 분석 설정과 다른 과거 실행입니다.",
  PUBLICATION_BLOCKED: "선택한 언어의 콘텐츠가 아직 공개 준비 상태가 아닙니다.",
};
