"use client";

import { useEffect, useState, useCallback } from "react";
import { analysisApi, EXPORT_BLOCK_MESSAGES } from "./api";
import { MethodologyNotice } from "./MethodologyNotice";
import { Map2D } from "./Map2D";
import { InlineSvg } from "./InlineSvg";
import { InterpretationEditor } from "./InterpretationEditor";
import { ExportPanel } from "./ExportPanel";
import { buildStressChartSvg, buildDendrogramSvg, type StressPoint } from "@/lib/analysis/view/svgFigures";
import { isRunButtonDisabled, isShepardUnavailable, SHEPARD_UNAVAILABLE_MESSAGE } from "@/lib/analysis/view/uiState";
import { buildDimensionDiagnosticsView } from "@/lib/analysis/view/dimensionDiagnosticsView";
import { cutClusters } from "@/lib/analysis/view/clusterCut";
import type { ExportPayload } from "@/lib/analysis/view/exportPayload";

const CONVERGENCE_REASON_LABELS: Record<string, string> = {
  CONVERGED: "예",
  STRESS_INCREASED: "아니오 (STRESS_INCREASED)",
  MAX_ITER_REACHED: "아니오 (MAX_ITER_REACHED)",
  NOT_APPLICABLE: "-",
};

/** Practical illustrative candidate range shown in the k-preview table — not a claim about the app's full supported range (which is 2..N, see the k input's min/max). */
const CANDIDATE_K_RANGE = [2, 3, 4, 5, 6, 7, 8, 9, 10];

type Scope = "KR" | "JP" | "ALL";

const SCOPE_LABELS: Record<Scope, string> = { KR: "한국", JP: "일본", ALL: "전체(KR+JP 통합)" };

type Eligibility = {
  eligible: boolean;
  errorCode: string | null;
  warnings: string[];
  participantCount: number;
  statementCount: number;
};

type RunMetadata = {
  id: string;
  scope: string;
  executionStatus: string;
  errorCode: string | null;
  errorMessageSafe: string | null;
  startedAt: string;
  finishedAt: string | null;
  includedParticipantCount: number;
  nKr: number;
  nJp: number;
  wardStatus: string;
  freshness: {
    numericFreshness: string;
    contentFreshnessKo: string;
    contentFreshnessJa: string;
    parameterStatus: string;
    publicationStatus: string;
    freshnessReasons: string[];
  };
};

function safeSlugFor(slug: string) {
  return slug.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function AnalysisPanel({ slug, adminToken }: { slug: string; adminToken: string }) {
  const api = analysisApi(slug, adminToken);
  const [scope, setScope] = useState<Scope>("KR");
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [runs, setRuns] = useState<RunMetadata[] | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [exportLang, setExportLang] = useState<"ko" | "ja">("ko");
  const [payload, setPayload] = useState<ExportPayload | null>(null);
  const [blockReason, setBlockReason] = useState<string | null>(null);
  const [interpretations, setInterpretations] = useState<
    { id: string; status: string; version: number; selectedClusterCount: number; axisLabels: string | null; quadrantLabels: string | null; notes: string | null }[]
  >([]);
  const [selectedInterpretationId, setSelectedInterpretationId] = useState<string | null>(null);
  const [newK, setNewK] = useState(3);
  const [creatingRun, setCreatingRun] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [showQuadrant, setShowQuadrant] = useState(false);

  const loadEligibility = useCallback(async () => {
    const res = await api.eligibility(scope);
    if (res.ok) setEligibility(res.body);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, slug, adminToken]);

  const loadRuns = useCallback(async () => {
    const res = await api.listRuns(scope);
    if (res.ok) {
      const list: RunMetadata[] = res.body.runs;
      setRuns(list);
      const officialCandidate = list.find(
        (r) =>
          r.executionStatus === "COMPLETED" &&
          r.freshness.numericFreshness === "CURRENT" &&
          r.freshness.parameterStatus === "CURRENT"
      );
      setSelectedRunId((prev) => prev ?? officialCandidate?.id ?? list[0]?.id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, slug, adminToken]);

  const loadExportPayload = useCallback(
    async (runId: string) => {
      setPayload(null);
      setBlockReason(null);
      const res = await api.exportData(runId, exportLang, selectedInterpretationId);
      if (res.ok) {
        setPayload(res.body);
      } else if (res.status === 409) {
        setBlockReason(res.body?.reason ?? "UNKNOWN");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [exportLang, selectedInterpretationId, slug, adminToken]
  );

  const loadInterpretations = useCallback(
    async (runId: string) => {
      const res = await api.listInterpretations(runId);
      if (res.ok) {
        setInterpretations(res.body.interpretations);
        setSelectedInterpretationId((prev) => prev ?? res.body.interpretations[0]?.id ?? null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slug, adminToken]
  );

  // Deferred via setTimeout(0), matching this codebase's existing convention
  // (AdminDashboard.tsx's readiness-tab effect) for triggering async loads
  // from an effect without calling setState synchronously in the effect body.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSelectedRunId(null);
      setSelectedInterpretationId(null);
      loadEligibility();
      loadRuns();
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (selectedRunId) {
        loadExportPayload(selectedRunId);
        loadInterpretations(selectedRunId);
      }
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId, exportLang, selectedInterpretationId]);

  async function handleRunAnalysis() {
    setCreatingRun(true);
    setCreateError(null);
    const res = await api.createRun(scope);
    setCreatingRun(false);
    if (!res.ok) {
      if (res.status === 409 && res.body?.errorCode === "RUN_ALREADY_RUNNING") {
        setCreateError("이미 실행 중인 분석이 있습니다. 완료될 때까지 기다려 주세요.");
      } else if (res.status === 500 && res.body?.errorCode === "ENGINE_SOURCE_SHA_UNAVAILABLE") {
        setCreateError("분석 실행 환경의 소스 버전을 확인할 수 없어 안전하게 실행을 중단했습니다.");
      } else if (res.status === 422 && res.body?.errorCode === "PARTICIPANT_COUNT_ZERO") {
        setCreateError("참여자가 없어 분석을 실행할 수 없습니다.");
      } else {
        setCreateError("분석 실행에 실패했습니다.");
      }
      return;
    }
    setSelectedRunId(res.body.id);
    loadRuns();
  }

  const selectedInterpretation = interpretations.find((i) => i.id === selectedInterpretationId) ?? null;
  // The live preview AND every export/ZIP builder must agree on the SAME
  // snapshot: the export payload's own interpretationStatus, never the
  // separately-refreshed interpretations list. A same-interpretation status
  // mutation (e.g. DRAFT -> FINALIZED) changes list state on save, but the
  // export payload is a different fetch — deriving isDraft from the list
  // let the map/exports show FINALIZED-adjacent UI while payload (and thus
  // any export built from it) still described stale DRAFT content. No
  // interpretation/no payload defaults to draft-like (matches prior
  // behavior where selectedInterpretation === null also read as draft).
  const isDraft = payload ? payload.meta.interpretationStatus !== "FINALIZED" : true;

  // Single entry point for every InterpretationEditor mutation (axis/quadrant
  // label edits, notes, cluster labels, finalize) — invalidates the current
  // export payload immediately so stale export controls (and the official
  // ZIP guard, which reads payload.meta.interpretationStatus) can never be
  // used during the refetch window, then refreshes both the interpretations
  // list and the export payload from the same mutation-completion boundary.
  async function handleInterpretationChanged() {
    if (!selectedRunId) return;
    setPayload(null);
    setBlockReason(null);
    await Promise.all([loadInterpretations(selectedRunId), loadExportPayload(selectedRunId)]);
  }

  const clusterAssignmentsMapPoints = (() => {
    if (!payload) return [];
    const dim = payload.dimensions.find((d) => d.dimension === payload.meta.primaryMapDimension);
    if (!dim?.coordinates) return [];
    return payload.statements.map((s, i) => ({
      statementId: s.id,
      order: s.order,
      x: dim.coordinates![i][0],
      y: dim.coordinates![i][1],
      clusterIndex: payload.clusters?.assignments.find((a) => a.statementId === s.id)?.clusterIndex ?? null,
    }));
  })();

  const stressPoints: StressPoint[] = payload
    ? payload.dimensions.map((d) => ({ dimension: d.dimension, normalizedStress1: d.commonStressDistance, failed: d.dimensionStatus === "FAILED" }))
    : [];

  const dimensionDiagnosticsRows = payload ? buildDimensionDiagnosticsView(payload.dimensions) : [];
  const primaryDimensionRow = dimensionDiagnosticsRows.find((r) => r.dimension === payload?.meta.primaryMapDimension) ?? null;
  const primaryDimensionNotConverged =
    primaryDimensionRow !== null && primaryDimensionRow.dimensionStatus === "COMPLETED" && primaryDimensionRow.converged === false;

  // Live, read-only preview of the currently-entered k's full cluster
  // membership — computed client-side from the same cutClusters() the
  // official "새 해석본 생성" flow uses, so both paths always agree. No
  // AnalysisInterpretation row is created just by typing a k value here.
  // Compact comparison across a practical candidate range — cluster count,
  // min/max size only (full per-k membership is available via the live
  // single-k preview above and the cluster-candidates CSV export). Never
  // labels any row as "optimal" — purely descriptive.
  const kComparisonRows = (() => {
    if (!payload?.ward) return [];
    const orderedIds = payload.statements.map((s) => s.id);
    const rows: { k: number; clusterCount: number; minSize: number; maxSize: number; sizeDistribution: number[] }[] = [];
    for (const k of CANDIDATE_K_RANGE) {
      if (k > payload.statements.length) continue;
      try {
        const assignments = cutClusters(payload.ward, orderedIds, k);
        const sizes = new Map<number, number>();
        assignments.forEach((a) => sizes.set(a.clusterIndex, (sizes.get(a.clusterIndex) ?? 0) + 1));
        const sizeDistribution = [...sizes.values()].sort((a, b) => a - b);
        rows.push({
          k,
          clusterCount: sizes.size,
          minSize: Math.min(...sizeDistribution),
          maxSize: Math.max(...sizeDistribution),
          sizeDistribution,
        });
      } catch {
        // k out of range for this statement count — skip.
      }
    }
    return rows;
  })();

  const kPreview = (() => {
    if (!payload?.ward) return null;
    if (!Number.isInteger(newK) || newK < 2 || newK > payload.statements.length) return null;
    try {
      const orderedIds = payload.statements.map((s) => s.id);
      const assignments = cutClusters(payload.ward, orderedIds, newK);
      const byCluster = new Map<number, number[]>();
      assignments.forEach((a) => {
        const cardNumber = payload.statements.find((s) => s.id === a.statementId)!.order + 1;
        if (!byCluster.has(a.clusterIndex)) byCluster.set(a.clusterIndex, []);
        byCluster.get(a.clusterIndex)!.push(cardNumber);
      });
      const clusters = [...byCluster.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([clusterIndex, numbers]) => ({ clusterIndex, statementNumbers: [...numbers].sort((x, y) => x - y) }));
      const allNumbers = clusters.flatMap((c) => c.statementNumbers);
      const uniqueNumbers = new Set(allNumbers);
      const n = payload.statements.length;
      const missing = Array.from({ length: n }, (_, i) => i + 1).filter((num) => !uniqueNumbers.has(num));
      return {
        clusters,
        validation: {
          assigned: allNumbers.length,
          missing: missing.length,
          duplicate: allNumbers.length - uniqueNumbers.size,
          overlap: allNumbers.length - uniqueNumbers.size,
          ok: allNumbers.length === n && missing.length === 0 && allNumbers.length === uniqueNumbers.size,
        },
      };
    } catch {
      return null;
    }
  })();

  return (
    <div className="space-y-6">
      <MethodologyNotice />

      {/* A. Scope selection */}
      <section className="space-y-2">
        <div className="flex gap-2">
          {(Object.keys(SCOPE_LABELS) as Scope[]).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                scope === s ? "bg-slate-900 text-white" : "border border-slate-300 hover:bg-slate-100"
              }`}
            >
              {SCOPE_LABELS[s]}
            </button>
          ))}
        </div>
        {scope === "ALL" && (
          <p className="text-xs text-slate-500">
            전체(ALL)는 국가별 동일 가중치 비교가 아니라, 한국·일본 참여자를 participant-level로 통합한 분석입니다.
          </p>
        )}
      </section>

      {/* B. Eligibility + run execution */}
      <section className="rounded-xl border border-slate-200 p-4 space-y-3 text-sm">
        <h3 className="font-semibold">분석 준비 상태 · 새 분석 실행</h3>
        {eligibility && (
          <ul className="text-xs text-slate-600 space-y-0.5">
            <li>참여자 수(N): {eligibility.participantCount}</li>
            <li>진술문 수: {eligibility.statementCount}</li>
            {eligibility.warnings.includes("EXPLORATORY_SINGLE_PARTICIPANT") && (
              <li className="text-amber-700">참여자 1명의 탐색적 결과이므로 해석에 각별한 주의가 필요합니다.</li>
            )}
          </ul>
        )}
        {createError && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-2 py-1.5">{createError}</p>}
        <button
          disabled={isRunButtonDisabled(eligibility?.eligible ?? null, creatingRun)}
          onClick={handleRunAnalysis}
          className="rounded-lg bg-slate-900 px-4 py-2 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
        >
          {creatingRun ? "분석 실행 중..." : "새 분석 실행"}
        </button>
      </section>

      {/* C. Current official result */}
      <section className="rounded-xl border border-slate-200 p-4 space-y-3 text-sm">
        <h3 className="font-semibold">현재 공식 결과</h3>
        {!selectedRunId && <p className="text-slate-500 text-xs">아직 실행된 분석이 없습니다.</p>}
        {selectedRunId && blockReason && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
            {EXPORT_BLOCK_MESSAGES[blockReason] ?? "현재 결과를 표시할 수 없습니다."}
          </p>
        )}
        {payload && (
          <div className="space-y-3">
            <div className="flex gap-2 text-xs">
              <button
                onClick={() => setExportLang("ko")}
                className={`rounded-full px-2 py-0.5 ${exportLang === "ko" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"}`}
              >
                한국어
              </button>
              <button
                onClick={() => setExportLang("ja")}
                className={`rounded-full px-2 py-0.5 ${exportLang === "ja" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"}`}
              >
                日本語
              </button>
              <label className="ml-auto flex items-center gap-1">
                <input type="checkbox" checked={showQuadrant} onChange={(e) => setShowQuadrant(e.target.checked)} />
                사분면 보조선
              </label>
            </div>

            <Map2D
              points={clusterAssignmentsMapPoints}
              showQuadrantLines={showQuadrant}
              axisLabels={
                selectedInterpretation?.axisLabels
                  ? { positiveX: selectedInterpretation.axisLabels }
                  : null
              }
              draft={isDraft}
            />

            <ExportPanel payload={payload} safeSlug={safeSlugFor(slug)} showQuadrantLines={showQuadrant} />
          </div>
        )}
      </section>

      {/* E. MDS diagnostics */}
      {payload && (
        <section className="rounded-xl border border-slate-200 p-4 space-y-3 text-sm">
          <h3 className="font-semibold">MDS 진단 (1D–5D)</h3>
          {primaryDimensionNotConverged && (
            <p className="text-xs text-red-800 bg-red-50 border border-red-300 rounded-lg px-2 py-1.5 font-medium">
              ⚠ 2차원 MDS가 수렴하지 않았습니다. 현재 좌표 및 Ward 군집 결과의 해석에 주의하십시오.
            </p>
          )}
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="pr-2">차원</th>
                <th className="pr-2">상태</th>
                <th className="pr-2">Stress-1</th>
                <th className="pr-2">설명량 R²</th>
                <th className="pr-2">ΔR²</th>
                <th className="pr-2">RSQ</th>
                <th className="pr-2">수렴 여부</th>
                <th className="pr-2">반복 횟수</th>
              </tr>
            </thead>
            <tbody>
              {dimensionDiagnosticsRows.map((d) => (
                <tr key={d.dimension}>
                  <td className="pr-2">{d.dimension}D</td>
                  <td className="pr-2">{d.dimensionStatus === "FAILED" ? "계산 실패" : "완료"}</td>
                  <td className="pr-2">{d.stress1 !== null ? d.stress1.toFixed(4) : "-"}</td>
                  <td className="pr-2">{d.rSquared !== null ? d.rSquared.toFixed(4) : "-"}</td>
                  <td className="pr-2">
                    {d.deltaRSquared === null
                      ? "—"
                      : `${d.deltaRSquared >= 0 ? "+" : ""}${d.deltaRSquared.toFixed(4)}`}
                  </td>
                  <td className="pr-2">{d.rsq !== null ? d.rsq.toFixed(4) : "-"}</td>
                  <td className="pr-2">
                    {d.dimensionStatus === "FAILED" ? (
                      "-"
                    ) : d.converged ? (
                      CONVERGENCE_REASON_LABELS.CONVERGED
                    ) : (
                      <span className="text-amber-700">{CONVERGENCE_REASON_LABELS[d.convergenceReason] ?? "아니오"}</span>
                    )}
                  </td>
                  <td className="pr-2">{d.iterations ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4 className="font-semibold text-xs pt-1">차원 증가에 따른 변화</h4>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="pr-2">구간</th>
                <th className="pr-2">ΔStress (감소량)</th>
                <th className="pr-2">ΔR² (증가량)</th>
              </tr>
            </thead>
            <tbody>
              {dimensionDiagnosticsRows.slice(1).map((d, i) => {
                const prevDim = dimensionDiagnosticsRows[i].dimension;
                return (
                  <tr key={d.dimension}>
                    <td className="pr-2">
                      {prevDim}D→{d.dimension}D
                    </td>
                    <td className="pr-2">{d.deltaStress !== null ? d.deltaStress.toFixed(4) : "-"}</td>
                    <td className="pr-2">
                      {d.deltaRSquared === null ? "-" : `${d.deltaRSquared >= 0 ? "+" : ""}${d.deltaRSquared.toFixed(4)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <InlineSvg svg={buildStressChartSvg(stressPoints)} ariaLabel="차원별 Stress 진단 그래프" />
          {isShepardUnavailable() && (
            <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5">
              Shepard 도표: {SHEPARD_UNAVAILABLE_MESSAGE}
            </p>
          )}
        </section>
      )}

      {/* F. Ward dendrogram */}
      {payload?.ward && (
        <section className="rounded-xl border border-slate-200 p-4 space-y-3 text-sm">
          <h3 className="font-semibold">Ward 군집분석</h3>
          <p className="text-xs text-slate-500">2차원 MDS 좌표(dimension={payload.meta.wardSourceDimension})의 Euclidean geometry를 입력으로 사용합니다.</p>
          <InlineSvg
            svg={buildDendrogramSvg(payload.ward.linkage, payload.ward.originalCount, payload.statements.map((s) => String(s.order + 1)))}
            ariaLabel="Ward dendrogram"
          />

          <div className="flex items-end gap-2 border-t border-slate-100 pt-3">
            <label className="text-xs text-slate-500">
              군집 수(k)
              <input
                type="number"
                min={2}
                max={payload.statements.length}
                value={newK}
                onChange={(e) => setNewK(Number(e.target.value))}
                className="mt-1 w-16 rounded-lg border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
            <button
              onClick={async () => {
                const res = await api.createInterpretation(selectedRunId!, newK);
                if (res.ok) {
                  setSelectedInterpretationId(res.body.id);
                  loadInterpretations(selectedRunId!);
                }
              }}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100"
            >
              새 해석본 생성 (DRAFT)
            </button>
            <span className="text-xs text-slate-400">최종 k는 연구자가 직접 선택합니다(자동 추천 없음).</span>
          </div>

          {kPreview && (
            <div className="border-t border-slate-100 pt-3 space-y-2">
              <h4 className="font-semibold text-xs">
                k={newK} 후보안 미리보기 (candidate — 아직 해석본으로 저장되지 않음)
              </h4>
              <p className="text-xs text-slate-500">
                군집 크기: {kPreview.clusters.map((c) => c.statementNumbers.length).join(", ")}
              </p>
              <div className="space-y-1 text-xs">
                {kPreview.clusters.map((c) => (
                  <p key={c.clusterIndex}>
                    <span className="font-medium">군집 {c.clusterIndex}:</span> {c.statementNumbers.join(", ")}
                  </p>
                ))}
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-500">
                    <th className="pr-2">군집</th>
                    <th className="pr-2">포함 문항 수</th>
                    <th className="pr-2">포함 문항 번호</th>
                  </tr>
                </thead>
                <tbody>
                  {kPreview.clusters.map((c) => (
                    <tr key={c.clusterIndex}>
                      <td className="pr-2">군집 {c.clusterIndex}</td>
                      <td className="pr-2">{c.statementNumbers.length}</td>
                      <td className="pr-2">{c.statementNumbers.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className={`text-xs ${kPreview.validation.ok ? "text-slate-500" : "text-red-700 font-medium"}`}>
                검증: assigned={kPreview.validation.assigned} · missing={kPreview.validation.missing} · duplicate=
                {kPreview.validation.duplicate} · overlap={kPreview.validation.overlap} ·{" "}
                {kPreview.validation.ok ? "정상" : "FAIL"}
              </p>
            </div>
          )}

          {kComparisonRows.length > 0 && (
            <div className="border-t border-slate-100 pt-3 space-y-2">
              <h4 className="font-semibold text-xs">후보 군집안 비교 (k={CANDIDATE_K_RANGE[0]}..{CANDIDATE_K_RANGE[CANDIDATE_K_RANGE.length - 1]})</h4>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-500">
                    <th className="pr-2">k</th>
                    <th className="pr-2">군집 수</th>
                    <th className="pr-2">최소 군집 크기</th>
                    <th className="pr-2">최대 군집 크기</th>
                    <th className="pr-2">군집 크기 분포</th>
                  </tr>
                </thead>
                <tbody>
                  {kComparisonRows.map((r) => (
                    <tr key={r.k}>
                      <td className="pr-2">{r.k}</td>
                      <td className="pr-2">{r.clusterCount}</td>
                      <td className="pr-2">{r.minSize}</td>
                      <td className="pr-2">{r.maxSize}</td>
                      <td className="pr-2">{r.sizeDistribution.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-slate-400">어떤 k도 &ldquo;최적&rdquo;으로 자동 선정하지 않습니다 — 최종 군집 수는 연구자가 직접 결정합니다.</p>
            </div>
          )}

          <p className="text-xs text-slate-400 border-t border-slate-100 pt-2">
            {interpretations.length === 0 ? "최종 군집 수 미선택" : `저장된 해석본 ${interpretations.length}개 (최종 k는 연구자가 확정)`}
          </p>
        </section>
      )}

      {/* G. Interpretation */}
      {selectedRunId && (
        <section className="space-y-3">
          <h3 className="font-semibold text-sm">해석안</h3>
          {interpretations.length > 1 && (
            <select
              value={selectedInterpretationId ?? ""}
              onChange={(e) => setSelectedInterpretationId(e.target.value)}
              className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
            >
              {interpretations.map((i) => (
                <option key={i.id} value={i.id}>
                  v{i.version} (k={i.selectedClusterCount}, {i.status})
                </option>
              ))}
            </select>
          )}
          {selectedInterpretation && (
            <InterpretationEditor
              slug={slug}
              adminToken={adminToken}
              interpretation={selectedInterpretation}
              onChanged={handleInterpretationChanged}
              onFinalizeConfirm={() =>
                window.confirm("확정 후에는 이 해석본을 직접 수정할 수 없으며, 변경하려면 새 해석본을 생성해야 합니다. 계속하시겠습니까?")
              }
            />
          )}
        </section>
      )}

      {/* D. History */}
      <section className="rounded-xl border border-slate-200 p-4 space-y-2 text-sm">
        <h3 className="font-semibold">분석 이력</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="pr-2">실행 시각</th>
                <th className="pr-2">scope</th>
                <th className="pr-2">N</th>
                <th className="pr-2">상태</th>
                <th className="pr-2">신선도</th>
                <th className="pr-2">Ward</th>
              </tr>
            </thead>
            <tbody>
              {(runs ?? []).map((r) => (
                <tr
                  key={r.id}
                  className={`cursor-pointer ${r.id === selectedRunId ? "bg-slate-50" : ""}`}
                  onClick={() => {
                    setSelectedRunId(r.id);
                    setSelectedInterpretationId(null);
                  }}
                >
                  <td className="pr-2 py-1">{new Date(r.startedAt).toLocaleString("ko-KR")}</td>
                  <td className="pr-2">{r.scope}</td>
                  <td className="pr-2">{r.includedParticipantCount}</td>
                  <td className="pr-2">
                    {r.executionStatus === "FAILED" ? `실패 (${r.errorCode ?? "-"})` : r.executionStatus}
                  </td>
                  <td className="pr-2">{r.freshness.numericFreshness === "CURRENT" ? "현재" : "이전 시점"}</td>
                  <td className="pr-2">{r.wardStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
