"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ResultBundle } from "@/lib/conceptMap/bundle";
import type { MetricRecord, Tone } from "@/lib/conceptMap/metrics";
import type { Reference } from "@/lib/conceptMap/references";
import { clusterStyle, markerPath } from "@/lib/conceptMap/mapModel";
import { toCsvText } from "@/lib/conceptMap/csv";
import { MapFigure } from "./MapFigure";
import { Dendrogram, DiffHeatmap, DimensionChart, Histogram, IterationChart, ShepardChart } from "./Charts";

type Scope = "KR" | "JP" | "ALL";
const SCOPES: { scope: Scope; label: string }[] = [
  { scope: "KR", label: "한국" },
  { scope: "JP", label: "일본" },
  { scope: "ALL", label: "한국–일본 전체" },
];

type RunMeta = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  executionStatus: string;
  algorithmVersion?: string;
  includedParticipantCount: number;
  nKr: number;
  nJp: number;
  statementCount: number;
  errorCode: string | null;
};
type HistoryRow = { id: string; startedAt: string; executionStatus: string; algorithmVersion: string; errorCode: string | null; current: boolean; hasPackage: boolean };
type Overview = {
  currentAlgorithmVersion: string;
  scopes: Record<Scope, { official: RunMeta | null; package: { filename: string; sha256: string; byteSize: number; createdAt: string } | null; history: HistoryRow[]; noOfficialResult: boolean }>;
};
type BundleResponse = { officialResult?: boolean; resultBodyBlocked: boolean; errorCode?: string | null; errorMessageSafe?: string | null; executionStatus: string; bundle?: ResultBundle };

const TONE_STYLE: Record<Tone, string> = {
  met: "bg-emerald-50 text-emerald-800 border-emerald-200",
  unfavorable: "bg-rose-50 text-rose-800 border-rose-200",
  neutral: "bg-slate-50 text-slate-700 border-slate-200",
  unconfirmed: "bg-amber-50 text-amber-800 border-amber-200",
};
const TONE_LABEL: Record<Tone, string> = { met: "충족", unfavorable: "불리", neutral: "참고", unconfirmed: "기준 미확정" };
const KIND_LABEL: Record<string, string> = {
  computation_setting: "계산 설정값",
  definitional_range: "정의상 범위",
  general_rule_of_thumb: "일반 MDS 참고 구분",
  empirical_comparison_range: "개념도 연구 비교 범위",
  good_fit_criterion_unconfirmed: "양호 기준(미확정)",
};

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function svgString(el: SVGSVGElement): string {
  const clone = el.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const vb = clone.viewBox.baseVal;
  clone.setAttribute("width", String(vb.width));
  clone.setAttribute("height", String(vb.height));
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
}

function downloadSvg(el: SVGSVGElement | null, name: string) {
  if (!el) return;
  saveBlob(new Blob([svgString(el)], { type: "image/svg+xml;charset=utf-8" }), `${name}.svg`);
}

function downloadPng(el: SVGSVGElement | null, name: string, scale = 3) {
  if (!el) return;
  const vb = el.viewBox.baseVal;
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svgString(el)], { type: "image/svg+xml;charset=utf-8" }));
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = vb.width * scale;
    canvas.height = vb.height * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    canvas.toBlob((b) => b && saveBlob(b, `${name}.png`), "image/png");
  };
  img.src = url;
}

function downloadCsv(rows: unknown[][], name: string) {
  saveBlob(new Blob([toCsvText(rows)], { type: "text/csv;charset=utf-8" }), `${name}.csv`);
}

const short = (h: string | undefined) => (h ? h.slice(0, 12) : "—");
const fmt = (v: number | null | undefined, d = 4) => (v === null || v === undefined || !Number.isFinite(v) ? "계산 불가" : v.toFixed(d));
const dt = (iso: string) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false }) + " KST";

export default function ConceptMapPanel({ slug, adminToken }: { slug: string; adminToken: string }) {
  const [scope, setScope] = useState<Scope>("ALL");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [stored, setStored] = useState<{ runId: string; data: BundleResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [dlBusy, setDlBusy] = useState(false);
  const [kChoice, setKChoice] = useState<{ runId: string; k: number } | null>(null);
  const [showQuadrants, setShowQuadrants] = useState(true);
  const [showNumbers, setShowNumbers] = useState(true);
  const [showBoundaries, setShowBoundaries] = useState(true);
  const [hl, setHl] = useState<{ key: string; cluster: number | null } | null>(null);

  const api = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/analysis/${path}`, {
        ...init,
        cache: "no-store",
        headers: { Authorization: `Bearer ${adminToken}`, ...(init?.headers ?? {}) },
      });
      return res;
    },
    [slug, adminToken]
  );

  const [reloadTick, setReloadTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await api("overview");
        if (!res.ok) throw new Error(String(res.status));
        const j = (await res.json()) as Overview;
        if (!cancelled) setOverview(j);
      } catch {
        if (!cancelled) setError("분석 목록을 불러오지 못했습니다.");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [api, reloadTick]);

  const runId = overview?.scopes[scope].official?.id ?? null;
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    api(`runs/${runId}/bundle`)
      .then(async (res) => {
        const j = (await res.json()) as BundleResponse;
        if (!cancelled) setStored({ runId, data: j });
      })
      .catch(() => !cancelled && setError("분석 결과를 불러오지 못했습니다."));
    return () => {
      cancelled = true;
    };
  }, [api, runId]);

  const resp = stored && stored.runId === runId ? stored.data : null;
  const loading = runId !== null && resp === null;
  const bundle = resp?.bundle ?? null;
  const rec = bundle?.naming.status === "ATTACHED" ? bundle.naming.proposal.recommendedK : null;
  const k = bundle ? (kChoice && kChoice.runId === runId && bundle.analysis.solutions.some((s) => s.k === kChoice.k) ? kChoice.k : (rec ?? bundle.analysis.solutions[0]?.k ?? null)) : null;
  const hlKey = `${runId}:${k}`;
  const highlight = hl && hl.key === hlKey ? hl.cluster : null;
  const setHighlight = (c: number | null) => setHl({ key: hlKey, cluster: c });

  const solution = bundle?.analysis.solutions.find((s) => s.k === k) ?? null;
  const proposal = bundle?.naming.status === "ATTACHED" ? bundle.naming.proposal : null;
  const names = proposal && solution && proposal.solution.k === solution.k && proposal.solution.signature === solution.signature ? proposal.solution.clusters : null;

  const mapRef = useRef<SVGSVGElement>(null);
  const dendRef = useRef<SVGSVGElement>(null);
  const heatRef = useRef<SVGSVGElement>(null);

  async function startRun() {
    if (!window.confirm(`${SCOPES.find((s) => s.scope === scope)!.label} 범위의 본조사 자료로 새 분석을 실행합니다. 원자료는 변경되지 않으며, 완료까지 1~3분 걸릴 수 있습니다. 계속할까요?`)) return;
    setRunning(true);
    setError(null);
    try {
      const res = await api("runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope, dataset: "MAIN" }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setError(`분석 실행 실패: ${j.errorCode ?? res.status}`);
      setReloadTick((t) => t + 1);
    } catch {
      setError("분석 실행 중 네트워크 오류가 발생했습니다.");
    } finally {
      setRunning(false);
    }
  }

  async function downloadZip() {
    if (!runId) return;
    setDlBusy(true);
    setError(null);
    try {
      const res = await api(`runs/${runId}/package`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(`ZIP을 내려받지 못했습니다: ${j.errorCode ?? res.status}`);
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") ?? "";
      const m = cd.match(/filename\*=UTF-8''([^;]+)/i);
      saveBlob(blob, m ? decodeURIComponent(m[1]) : `${scope}_analysis_package.zip`);
    } catch {
      setError("ZIP 내려받기 중 네트워크 오류가 발생했습니다.");
    } finally {
      setDlBusy(false);
    }
  }

  const info = overview?.scopes[scope];
  const label = SCOPES.find((s) => s.scope === scope)!.label;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {SCOPES.map((s) => (
            <button
              key={s.scope}
              onClick={() => setScope(s.scope)}
              className={`rounded-lg border px-4 py-2 text-sm font-medium ${scope === s.scope ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 hover:bg-slate-100"}`}
              aria-pressed={scope === s.scope}
            >
              {s.label}
            </button>
          ))}
          <div className="ml-auto flex gap-2">
            <button onClick={startRun} disabled={running} className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-50">
              {running ? "분석 실행 중…" : `${label} 새 분석 실행`}
            </button>
            <button onClick={downloadZip} disabled={dlBusy || !info?.package} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50" title={info?.package ? info.package.filename : "이 결과에 연결된 ZIP이 아직 없습니다"}>
              {dlBusy ? "내려받는 중…" : `${label} 전체 분석자료 다운로드 (ZIP)`}
            </button>
          </div>
        </div>
        {info?.package && (
          <p className="text-xs text-slate-500">
            {info.package.filename} · {(info.package.byteSize / 1024 / 1024).toFixed(1)} MB · SHA-256 {short(info.package.sha256)}… · 등록 {dt(info.package.createdAt)}
          </p>
        )}
        {!info?.package && info?.official && <p className="text-xs text-amber-700">이 분석 결과에 연결된 ZIP 패키지가 아직 없습니다 (화면의 개별 그림·CSV 내려받기는 사용할 수 있습니다).</p>}
        {error && <p className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{error}</p>}
      </div>

      {!overview && !error && <p className="text-sm text-slate-500">불러오는 중…</p>}
      {overview && info?.noOfficialResult && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          {label} 범위에는 현재 알고리즘 버전({overview.currentAlgorithmVersion})의 검증된 분석 결과가 없습니다. 이전 방식의 결과는 표시하지 않습니다. 위 &ldquo;새 분석 실행&rdquo;으로 분석을 만드세요.
        </div>
      )}
      {loading && <p className="text-sm text-slate-500">결과를 불러오는 중…</p>}
      {resp?.resultBodyBlocked && <p className="text-sm text-amber-800">이 결과는 최신 자료·설정과 일치하지 않아 표시하지 않습니다 ({resp.errorCode ?? "STALE"}).</p>}

      {bundle && (
        <>
          <RunHeader bundle={bundle} runStatus={resp!.executionStatus} />
          <ConvergenceVsFit bundle={bundle} />

          <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="font-semibold">2차원 개념도 — {label}</h3>
              {bundle.analysis.solutions.length > 0 && (
                <label className="text-sm flex items-center gap-2">
                  군집 수
                  <select value={k ?? ""} onChange={(e) => { if (runId) setKChoice({ runId, k: Number(e.target.value) }); }} className="rounded border border-slate-300 px-2 py-1 text-sm">
                    {bundle.analysis.solutions.map((s) => (
                      <option key={s.k} value={s.k}>
                        {s.k}{s.k === rec ? " (추천)" : proposal?.alternatives.some((a) => a.k === s.k) ? " (비교 대안)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="ml-auto flex flex-wrap gap-3 text-sm">
                <Toggle label="사분면 기준선" v={showQuadrants} set={setShowQuadrants} />
                <Toggle label="문항 번호" v={showNumbers} set={setShowNumbers} />
                <Toggle label="군집 경계·명칭" v={showBoundaries} set={setShowBoundaries} />
              </div>
            </div>
            {proposal && (
              <p className="text-xs rounded border border-amber-200 bg-amber-50 text-amber-900 px-3 py-2">
                검토 상태: <b>{proposal.reviewStatus === "AUTO_PROPOSED" ? "자동 제안 (연구자 검토 전)" : proposal.reviewStatus}</b> — 추천 군집 수 {proposal.recommendedK}와 군집명은 문항 내용을 읽고 만든 제안이며 참여자·전문가 합의를 거친 확정 명칭이 아닙니다. &lsquo;최적&rsquo;은 검토한 후보와 아래 기준에서의 추천을 뜻합니다.
              </p>
            )}
            {bundle.naming.status === "SIGNATURE_MISMATCH" && <p className="text-xs text-rose-700">군집명 제안이 이 분석의 군집 소속과 맞지 않아 표시하지 않습니다 ({bundle.naming.detail}).</p>}
            {solution && bundle.analysis.primary.coordinates ? (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,640px)_minmax(0,1fr)]">
                <div>
                  <MapFigure ref={mapRef} coordinates={bundle.analysis.primary.coordinates} solution={solution} names={names} showQuadrants={showQuadrants} showNumbers={showNumbers} showBoundaries={showBoundaries} highlightCluster={highlight} title={`${label} 개념도 (2차원, ${solution.k}군집)`} />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <SmallBtn onClick={() => downloadSvg(mapRef.current, `${scope}_concept_map_k${solution.k}`)}>지도 SVG</SmallBtn>
                    <SmallBtn onClick={() => downloadPng(mapRef.current, `${scope}_concept_map_k${solution.k}`)}>지도 PNG</SmallBtn>
                    <SmallBtn onClick={() => downloadCsv([["statement", "x_dim1", "y_dim2", "cluster", "cluster_name"], ...bundle.analysis.primary.coordinates!.map((c, i) => [bundle.statements[i].no, c[0], c[1], solution.labels[i], names?.find((n) => n.cluster === solution.labels[i])?.nameKo ?? ""])], `${scope}_coordinates_k${solution.k}`)}>좌표·소속 CSV</SmallBtn>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                    각 점은 문항 1개이며 좌표는 변경되지 않았습니다. 같은 색·기호가 같은 군집이고, 볼록 껍질(convex hull) 외곽선과 옅은 채움은 군집 소속 표시일 뿐 인과·영향 경로가 아닙니다. 1~2개 점 군집은 원/굵은 선분, 일직선 군집은 양 끝점 선분으로 표시합니다. 번호가 겹치면 글자 위치만 옮기고 안내선으로 연결합니다. 사분면(Ⅰ~Ⅳ)은 x=0, y=0 기준선에 의한 시각적 구획이며 군집이 4개라는 뜻도, 축에 실질적 의미가 있다는 뜻도 아닙니다(축 의미 부여에는 별도 내용 근거와 연구자 검토 필요). 지도의 방향은 임의적이고 군집의 크기·모양에는 의미 있는 해석이 없으며(Trochim et al., 1994), 국가별 지도는 정렬 절차 없이 같은 사분면이라는 이유만으로 같은 의미로 해석할 수 없습니다. 중요도·실행가능성 평정은 수집되지 않아 Go-Zone은 없습니다.
                  </p>
                  {solution.clusters.some((c) => c.foreignPointsInside.length > 0) && (
                    <p className="mt-1 text-[11px] text-amber-800">
                      다른 군집의 점이 경계 안에 들어온 군집: {solution.clusters.filter((c) => c.foreignPointsInside.length > 0).map((c) => `군집 ${c.cluster}(S${c.foreignPointsInside.map((i) => i + 1).join(",S")})`).join(" · ")} — 소속은 색·기호와 아래 표로 확인하세요.
                    </p>
                  )}
                </div>
                <ClusterList bundle={bundle} solution={solution} names={names} highlight={highlight} setHighlight={setHighlight} />
              </div>
            ) : (
              <p className="text-sm text-slate-500">군집분석 결과가 없습니다.</p>
            )}
          </section>

          <ClusterComparison bundle={bundle} rec={rec} proposal={proposal} />

          {bundle.analysis.ward && solution && (
            <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
              <h3 className="font-semibold">Ward 계층적 군집분석 — 덴드로그램·병합 이력</h3>
              <p className="text-xs text-slate-500">2차원 지도 좌표에 대한 Ward 최소분산 군집(Lance–Williams 갱신, 제곱 유클리드 거리 기반; 병합 높이 = √(2·n_a·n_b/(n_a+n_b))·‖중심 차이‖, 병합 비용 = 군집 내 제곱합 증가량 = 높이²/2). 점선은 선택한 군집 수의 절단선입니다. 군집 수 선택은 MDS 수렴과 별개의 판단입니다.</p>
              <Dendrogram ref={dendRef} linkage={bundle.analysis.ward.linkage} n={bundle.analysis.statementCount} labels={solution.labels} k={solution.k} title={`${label} Ward 덴드로그램 (k=${solution.k} 절단)`} />
              <div className="flex gap-2">
                <SmallBtn onClick={() => downloadSvg(dendRef.current, `${scope}_dendrogram`)}>덴드로그램 SVG</SmallBtn>
                <SmallBtn onClick={() => downloadPng(dendRef.current, `${scope}_dendrogram`)}>PNG</SmallBtn>
                <SmallBtn onClick={() => downloadCsv([["step", "left", "right", "height", "ward_cost(ssw_increase)", "size_after", "clusters_after"], ...bundle.analysis.ward!.merges.map((m) => [m.step, m.left, m.right, m.height, m.wssIncrease, m.sizeAfter, m.clustersAfter])], `${scope}_ward_merges`)}>병합 이력 CSV</SmallBtn>
              </div>
              <details className="text-xs">
                <summary className="cursor-pointer text-slate-600">전체 병합 이력 ({bundle.analysis.ward.merges.length}단계)</summary>
                <div className="max-h-64 overflow-auto mt-2">
                  <table className="w-full text-right">
                    <thead className="sticky top-0 bg-slate-50"><tr><th className="p-1 text-left">단계</th><th>병합 대상(왼쪽, 오른쪽)</th><th>높이</th><th>병합 비용</th><th>병합 후 크기</th><th>남은 군집 수</th></tr></thead>
                    <tbody>{bundle.analysis.ward.merges.map((m) => (<tr key={m.step} className="border-t"><td className="p-1 text-left">{m.step}</td><td>{m.left}, {m.right}</td><td>{m.height.toFixed(4)}</td><td>{m.wssIncrease.toFixed(4)}</td><td>{m.sizeAfter}</td><td>{m.clustersAfter}</td></tr>))}</tbody>
                  </table>
                </div>
              </details>
            </section>
          )}

          <Diagnostics bundle={bundle} scope={scope} label={label} />

          {bundle.comparison && (
            <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
              <h3 className="font-semibold">한국·일본 비교 (탐색적)</h3>
              <p className="text-xs text-slate-500">N이 다른 빈도를 직접 비교하지 않고 P_KR = S_KR/N_KR(N={bundle.comparison.nKr}), P_JP = S_JP/N_JP(N={bundle.comparison.nJp})를 사용했습니다. 1,081개 문항 쌍은 독립 관측치가 아니므로 일반 상관검정의 p값은 제시하지 않습니다. 전체 결과는 한국·일본을 포함하므로 세 범위를 독립 표본처럼 비교하지 않습니다.</p>
              <p className="text-sm">동일 문항 쌍의 Pearson r = <b>{fmt(bundle.comparison.pearson, 3)}</b>, Spearman ρ = <b>{fmt(bundle.comparison.spearman, 3)}</b>; |P_KR−P_JP| 평균 {fmt(bundle.comparison.meanAbsDiff, 3)}, 최대 {fmt(bundle.comparison.maxAbsDiff, 3)}.</p>
              <DiffHeatmap ref={heatRef} matrix={bundle.comparison.Skr.map((row, i) => row.map((v, j) => (i === j ? 0 : v / bundle.comparison!.nKr - bundle.comparison!.Sjp[i][j] / bundle.comparison!.nJp)))} limit={bundle.comparison.diffColorLimit} title="P_KR − P_JP (색 범위 ±최대 |차이|, 두 국가 공통)" />
              <div className="flex gap-2"><SmallBtn onClick={() => downloadSvg(heatRef.current, "KR-JP_difference_heatmap")}>히트맵 SVG</SmallBtn><SmallBtn onClick={() => downloadPng(heatRef.current, "KR-JP_difference_heatmap")}>PNG</SmallBtn></div>
              <p className="text-[11px] text-slate-500">가장 크게 다른 문항 쌍(상위 10): {bundle.comparison.topDifferences.slice(0, 10).map((d) => `S${d.i + 1}–S${d.j + 1} (${d.diff >= 0 ? "+" : ""}${d.diff.toFixed(2)})`).join(", ")}</p>
            </section>
          )}

          <MetricsSection metrics={bundle.metrics} references={bundle.references} />
          <HistorySection history={info?.history ?? []} current={runId} />
        </>
      )}
    </div>
  );
}

function Toggle({ label, v, set }: { label: string; v: boolean; set: (b: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5 cursor-pointer">
      <input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  );
}
function SmallBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="rounded border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-100">
      {children}
    </button>
  );
}

function RunHeader({ bundle, runStatus }: { bundle: ResultBundle; runStatus: string }) {
  const m = bundle.meta;
  const s = bundle.analysis.settings;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">분석 개요</h3>
        <span className="rounded bg-emerald-100 text-emerald-800 text-xs px-2 py-0.5">새 분석 결과 (엔진 v{m.algorithmVersion})</span>
        <span className="text-xs text-slate-500">상태 {runStatus}</span>
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Item k="유효 참여자 N" v={`${m.N}명 (한국 ${m.nKr} · 일본 ${m.nJp})`} />
        <Item k="진술문 수" v={`${m.statementCount}개`} />
        <Item k="조사 단계" v="본조사(MAIN)만" />
        <Item k="자료 기준 시점" v={dt(m.dataSnapshotAt)} />
        <Item k="분석 실행 시각" v={dt(m.computedAt)} />
        <Item k="계산 소요" v={`${(m.computeMs / 1000).toFixed(1)}초 (Node ${m.nodeVersion})`} />
        <Item k="소스 커밋" v={short(m.engineSourceCommitSha)} />
        <Item k="자료 지문(참여자 응답)" v={`${short(m.fingerprints.participantsHash)}…`} />
        <Item k="행렬 지문 / 설정 지문" v={`${short(m.fingerprints.numericDataHash)}… / ${short(m.fingerprints.parameterHash)}…`} />
        <Item k="실행 ID" v={short(m.runId)} />
      </dl>
      <p className="text-xs text-slate-600 leading-relaxed">
        <b>분석 설정</b>: 2차원 비계량(서열) SMACOF, 동점 처리 {s.mds.tieHandling}, 입력 비유사성 δ = 1 − S/N (대각선 0, 가중치 모두 1), 디스패리티 정규화 Σd̂² = n(n−1)/2, 시작 {s.mds.nInit}회(seed {s.mds.randomSeed}에서 파생) · 시작당 최대 {s.mds.maxIter}회 · 허용오차 {s.mds.eps} → 선택한 해를 {s.mds.strictEps}로 재검증. 여러 시작 중 최저 해를 고른 것이며 전역 최적을 증명하지 않습니다. 1~5차원은 보조 비교이며 3차원 이상 결과를 2차원 지도로 쓰지 않았습니다. 이 설정값은 이번 계산의 설정이며 문헌상의 적합도 합격선이 아닙니다.
      </p>
    </section>
  );
}
function Item({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <dt className="text-slate-500 shrink-0">{k}</dt>
      <dd className="font-medium break-all">{v}</dd>
    </div>
  );
}

function ConvergenceVsFit({ bundle }: { bundle: ResultBundle }) {
  const conv = bundle.metrics.filter((m) => m.group === "convergence");
  const fit = bundle.metrics.filter((m) => m.group === "fit" && ["stress1", "rsq", "raw_stress"].includes(m.id));
  const p = bundle.analysis.primary;
  return (
    <section className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
        <h3 className="font-semibold">계산 수렴 여부 <span className="text-xs font-normal text-slate-500">(수치적 사실)</span></h3>
        {conv.map((m) => <VerdictBlock key={m.id} m={m} compact />)}
        <p className="text-[11px] text-slate-500">종료 사유: 주 실행 {p.selected?.main.reason ?? "—"} · 엄격 계속 {p.selected?.strict.reason ?? "—"} · 최종 변화량 {p.selected ? `${p.selected.main.finalRelativeChange?.toExponential(2)} / ${p.selected.strict.finalRelativeChange?.toExponential(2)}` : "—"} (분모: 직전 반복의 raw stress)</p>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
        <h3 className="font-semibold">적합도 평가 <span className="text-xs font-normal text-slate-500">(자료와 2차원 모델의 관계 · 수렴과 별개)</span></h3>
        {fit.map((m) => <VerdictBlock key={m.id} m={m} compact />)}
        <p className="text-[11px] text-slate-500">미충족·미확정 항목을 하나의 &lsquo;양호&rsquo;로 묶지 않았습니다. 지표별 기준·출처·한계는 아래 &lsquo;지표별 기준·출처&rsquo;에 있습니다.</p>
      </div>
    </section>
  );
}

function VerdictBlock({ m, compact }: { m: MetricRecord; compact?: boolean }) {
  return (
    <div className="space-y-1 text-sm">
      <div className="font-medium">{m.nameKo}: <span className="font-normal">{m.valueDisplay}</span></div>
      {m.verdicts.map((v, i) => (
        <div key={i} className={`rounded border px-2 py-1 text-xs ${TONE_STYLE[v.tone]}`}>
          <b>{v.aspectKo}</b> [{TONE_LABEL[v.tone]}] {v.textKo}
        </div>
      ))}
      {!compact && null}
    </div>
  );
}

function ClusterList({ bundle, solution, names, highlight, setHighlight }: { bundle: ResultBundle; solution: NonNullable<ResultBundle["analysis"]["solutions"][number]>; names: import("@/lib/conceptMap/proposals/types").ClusterProposal[] | null; highlight: number | null; setHighlight: (c: number | null) => void }) {
  const sil = solution.silhouetteMap.perPoint;
  return (
    <div className="space-y-2 max-h-[760px] overflow-auto pr-1">
      {solution.clusters.map((c) => {
        const st = clusterStyle(c.cluster);
        const nm = names?.find((n) => n.cluster === c.cluster);
        const open = highlight === c.cluster;
        const boundary = c.members.filter((i) => sil[i] < 0.1).sort((a, b) => sil[a] - sil[b]);
        return (
          <div key={c.cluster} className={`rounded-lg border ${open ? "border-slate-900 shadow" : "border-slate-200"}`}>
            <button className="w-full text-left p-2 flex items-center gap-2" onClick={() => setHighlight(open ? null : c.cluster)} aria-expanded={open}>
              <svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden><path d={markerPath(st.marker, 5.5)} fill={st.marker === "ring" ? "#fff" : st.color} stroke={st.color} strokeWidth={st.marker === "ring" ? 2 : 1} /></svg>
              <span className="text-sm font-medium">군집 {c.cluster}{nm ? ` · ${nm.nameKo}` : ""}</span>
              <span className="ml-auto text-xs text-slate-500">{c.size}문항 · 평균 실루엣 {fmt(c.meanSilhouette, 2)}</span>
            </button>
            {open && (
              <div className="border-t p-2 space-y-2 text-xs">
                {nm && (
                  <div className="space-y-1">
                    <div><b>일본어(검토용 번역안)</b>: {nm.nameJa}</div>
                    <div><b>핵심 내용</b>: {nm.coreContentKo}</div>
                    <div><b>명명 근거</b>: {nm.basisKo}</div>
                    <div><b>대표 문항</b>: {nm.representativeStatements.map((n) => `S${n}`).join(", ")}</div>
                  </div>
                )}
                {boundary.length > 0 && <div><b>경계 문항(지도 실루엣 &lt; 0.1)</b>: {boundary.map((i) => `S${i + 1}(${sil[i].toFixed(2)})`).join(", ")}</div>}
                {c.foreignPointsInside.length > 0 && <div className="text-amber-800">경계 안에 있는 다른 군집 문항: {c.foreignPointsInside.map((i) => `S${i + 1}`).join(", ")}</div>}
                <table className="w-full">
                  <thead><tr className="text-left text-slate-500"><th className="w-10">번호</th><th>한국어</th><th>日本語</th></tr></thead>
                  <tbody>
                    {c.members.map((i) => (
                      <tr key={i} className="border-t align-top">
                        <td className="py-1 font-medium">S{String(i + 1).padStart(2, "0")}</td>
                        <td className="py-1 pr-2">{bundle.statements[i].textKo}</td>
                        <td className="py-1 text-slate-600">{bundle.statements[i].textJa ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ClusterComparison({ bundle, rec, proposal }: { bundle: ResultBundle; rec: number | null; proposal: import("@/lib/conceptMap/proposals/types").ScopeProposal | null }) {
  const merges = bundle.analysis.ward?.merges ?? [];
  const heightTo = (k: number) => merges.find((m) => m.clustersAfter === k)?.height;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
      <h3 className="font-semibold">군집 수 비교</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs text-right">
          <thead className="bg-slate-50">
            <tr><th className="p-1.5 text-left">군집 수 k</th><th>최소 군집 크기</th><th>2문항 이하 군집</th><th>지도 실루엣 평균</th><th>δ 실루엣 평균</th><th>군집 간 제곱합 비율</th><th>k+1→k 병합 높이</th><th className="text-left pl-2">비고</th></tr>
          </thead>
          <tbody>
            {bundle.analysis.solutions.map((s) => {
              const alt = proposal?.alternatives.find((a) => a.k === s.k);
              return (
                <tr key={s.k} className={`border-t ${s.k === rec ? "bg-indigo-50 font-medium" : ""}`}>
                  <td className="p-1.5 text-left">{s.k}{s.k === rec ? " ★추천" : alt ? " 대안" : ""}</td>
                  <td>{s.minSize}</td><td>{s.smallClusters}</td><td>{fmt(s.silhouetteMap.mean, 3)}</td><td>{fmt(s.silhouetteDelta.mean, 3)}</td><td>{fmt(s.betweenShare, 3)}</td>
                  <td>{heightTo(s.k) !== undefined ? heightTo(s.k)!.toFixed(3) : "—"}</td>
                  <td className="text-left pl-2 text-slate-600 max-w-[34rem]">{alt?.commentKo ?? ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {proposal && (
        <div className="space-y-1 text-xs">
          <div className="font-medium">추천 근거 (검토한 후보와 아래 기준에서의 추천이며 수학적 유일 정답이 아님)</div>
          <ul className="list-disc pl-5 space-y-0.5">{proposal.recommendationRationaleKo.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      )}
      <p className="text-[11px] text-slate-500">실루엣은 보조 지표 하나만으로 군집 수를 확정하는 데 쓰지 않았습니다. 지도 실루엣은 2차원 지도 거리, δ 실루엣은 원래 비유사성 기준입니다(Rousseeuw, 1987). 군집 간 제곱합 비율은 k에 대해 단조 증가하므로 군집 수 선택 기준이 아닙니다.</p>
    </section>
  );
}

function Diagnostics({ bundle, scope, label }: { bundle: ResultBundle; scope: Scope; label: string }) {
  const shepRef = useRef<SVGSVGElement>(null);
  const iterRef = useRef<SVGSVGElement>(null);
  const dimRef = useRef<SVGSVGElement>(null);
  const histRef = useRef<SVGSVGElement>(null);
  const a = bundle.analysis;
  const p = a.primary;
  const pairs = a.pairDiagnostics;
  const sh = a.splitHalf;
  const raw = sh.rawValues.filter((v): v is number => v !== null);
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-4">
      <h3 className="font-semibold">MDS 진단</h3>
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          {pairs && <ShepardChart ref={shepRef} delta={pairs.map((x) => x.delta)} distance={pairs.map((x) => x.distance)} disparity={pairs.map((x) => x.disparityKruskal)} title={`${label} Shepard 다이어그램 (2차원)`} />}
          <div className="mt-1 flex gap-2">
            <SmallBtn onClick={() => downloadSvg(shepRef.current, `${scope}_shepard`)}>SVG</SmallBtn>
            <SmallBtn onClick={() => downloadPng(shepRef.current, `${scope}_shepard`)}>PNG</SmallBtn>
            {pairs && <SmallBtn onClick={() => downloadCsv([["i", "j", "S", "P", "D", "delta", "distance_d", "disparity_normalized(dhat; used by raw stress, sqrt(raw/q), RSQ)", "residual_normalized(dhat-d)", "disparity_kruskal(dhat*; used by Stress-1)", "residual_kruskal(dhat*-d)"], ...pairs.map((x) => [`S${String(x.i + 1).padStart(2, "0")}`, `S${String(x.j + 1).padStart(2, "0")}`, x.S, x.P, x.D, x.delta, x.distance, x.disparity, x.residual, x.disparityKruskal, x.residualKruskal])], `${scope}_pair_diagnostics`)}>1,081쌍 진단표 CSV</SmallBtn>}
          </div>
        </div>
        <div>
          {p.trace && <IterationChart ref={iterRef} rawStress={p.trace.rawStress} mainRunIterations={p.selected?.main.iterations ?? 0} thinned={p.trace.thinned} title={`${label} 목적함수(raw stress) 반복 이력`} />}
          <div className="mt-1 flex gap-2">
            <SmallBtn onClick={() => downloadSvg(iterRef.current, `${scope}_objective_history`)}>SVG</SmallBtn>
            <SmallBtn onClick={() => downloadPng(iterRef.current, `${scope}_objective_history`)}>PNG</SmallBtn>
            {p.trace && <SmallBtn onClick={() => downloadCsv([["iteration", "raw_stress"], ...p.trace!.rawStress.map((v, i) => [i + 1, v])], `${scope}_objective_history`)}>CSV</SmallBtn>}
          </div>
        </div>
        <div>
          <DimensionChart ref={dimRef} data={a.dimensions.map((d) => ({ dimension: d.dimension, stress1: d.stress1, converged: d.numericallyConverged }))} title={`${label} 차원별 Stress-1 (1~5차원, 보조 비교)`} />
          <div className="mt-1 flex gap-2">
            <SmallBtn onClick={() => downloadSvg(dimRef.current, `${scope}_stress_by_dimension`)}>SVG</SmallBtn>
            <SmallBtn onClick={() => downloadPng(dimRef.current, `${scope}_stress_by_dimension`)}>PNG</SmallBtn>
          </div>
        </div>
        <div>
          {raw.length > 0 && <Histogram ref={histRef} values={raw} xLabel="반쪽 행렬 간 상관 r (원상관)" title={`${label} 반복 분할 신뢰도 분포 (${sh.repetitions}회)`} mark={[{ label: "평균", value: sh.rawR!.mean }]} />}
          <div className="mt-1 flex gap-2">
            <SmallBtn onClick={() => downloadSvg(histRef.current, `${scope}_split_half`)}>SVG</SmallBtn>
            <SmallBtn onClick={() => downloadPng(histRef.current, `${scope}_split_half`)}>PNG</SmallBtn>
          </div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs text-right">
          <thead className="bg-slate-50"><tr><th className="p-1.5 text-left">차원</th><th>Stress-1</th><th>√(raw/q)</th><th>raw stress</th><th>RSQ</th><th>수렴 시작 수</th><th>선택 시작(주/엄격 종료 사유)</th><th>반복(주+엄격)</th><th className="text-left pl-2">비고</th></tr></thead>
          <tbody>
            {a.dimensions.map((d) => (
              <tr key={d.dimension} className={`border-t ${d.isPrimary ? "bg-indigo-50 font-medium" : ""}`}>
                <td className="p-1.5 text-left">{d.dimension}D{d.isPrimary ? " (지도)" : ""}</td>
                <td>{fmt(d.stress1, 4)}</td><td>{fmt(d.stressNormalizedSqrt, 4)}</td><td>{fmt(d.rawStress, 3)}</td><td>{fmt(d.rsq, 3)}</td>
                <td>{d.convergedStarts}/{d.startCount}</td>
                <td>{d.selected ? `#${d.selected.initIndex} ${d.selected.main.reason}/${d.selected.strict.reason}` : "—"}</td>
                <td>{d.selected ? d.selected.main.iterations + d.selected.strict.iterations : "—"}</td>
                <td className="text-left pl-2 text-slate-600">{d.numericallyConverged ? "수렴" : "미수렴"}{d.isPrimary ? "" : " · 보조"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-slate-600">2차원 초기화별 결과 ({p.starts.length}회, seed·종료 사유·반복·raw stress)</summary>
        <div className="max-h-64 overflow-auto mt-2">
          <table className="w-full text-right">
            <thead className="sticky top-0 bg-slate-50"><tr><th className="p-1 text-left">#</th><th>seed</th><th>종료 사유</th><th>반복</th><th>raw stress</th><th>Stress-1</th><th>최종 변화량</th><th>선택</th></tr></thead>
            <tbody>
              {p.starts.map((s) => (
                <tr key={s.initIndex} className={`border-t ${p.selected?.initIndex === s.initIndex ? "bg-indigo-50 font-medium" : ""}`}>
                  <td className="p-1 text-left">{s.initIndex}</td><td>{s.seed}</td><td>{s.reason}</td><td>{s.iterations}</td><td>{fmt(s.rawStress, 5)}</td><td>{fmt(s.stress1, 4)}</td><td>{s.finalRelativeChange === null ? "—" : s.finalRelativeChange.toExponential(2)}</td><td>{p.selected?.initIndex === s.initIndex ? "◀ 선택" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-slate-500">선택 기준: 오류 없이 수렴한 시작 중 raw stress가 가장 작은 해. 선택 후 허용오차 {a.settings.mds.strictEps}로 계속 최적화.</p>
      </details>
    </section>
  );
}

function MetricsSection({ metrics, references }: { metrics: MetricRecord[]; references: Reference[] }) {
  const refByKey = useMemo(() => new Map(references.map((r) => [r.key, r])), [references]);
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
      <h3 className="font-semibold">지표별 기준·출처·한계</h3>
      <p className="text-xs text-slate-500">각 지표에 정의·계산식·실제 값·기준의 종류·판정·출처·한계를 함께 적었습니다. 기준은 (1) 이번 계산의 설정값, (2) 정의상 범위, (3) 일반 MDS 참고 구분, (4) 개념도 연구의 경험적 비교 범위, (5) 양호 기준으로 확인된 값으로 구분하며 서로 섞지 않았습니다. 원문에서 확인하지 못한 기준은 &lsquo;기준 미확정&rsquo;으로 표시했습니다.</p>
      {metrics.map((m) => (
        <details key={m.id} className="rounded-lg border border-slate-200 p-3 text-sm">
          <summary className="cursor-pointer font-medium">{m.nameKo} <span className="font-normal text-slate-500">— {m.valueDisplay}</span></summary>
          <div className="mt-2 space-y-2 text-xs">
            <p><b>정의</b>: {m.definitionKo}</p>
            <p><b>계산식</b>: <code className="bg-slate-100 px-1">{m.formula}</code></p>
            <div><b>기준</b><ul className="mt-1 space-y-1">{m.criteria.map((c, i) => (<li key={i} className="rounded border border-slate-200 p-2"><span className="rounded bg-slate-100 px-1.5 py-0.5 mr-1">{KIND_LABEL[c.kind]}</span><b>{c.labelKo}</b>: {c.text}{c.location ? <span className="text-slate-500"> [위치: {c.location}]</span> : null}</li>))}</ul></div>
            <div><b>판정</b><div className="mt-1 space-y-1">{m.verdicts.map((v, i) => (<div key={i} className={`rounded border px-2 py-1 ${TONE_STYLE[v.tone]}`}>{v.aspectKo} [{TONE_LABEL[v.tone]}] {v.textKo}</div>))}</div></div>
            <div><b>출처</b><ul className="mt-1 list-disc pl-5">{m.sourceKeys.map((k) => { const r = refByKey.get(k); return r ? (<li key={k}>{r.apa.replace(/\*/g, "")} <span className="text-slate-500">[열람 상태: {accessLabel(r.access)}]</span>{r.url ? <> <a className="text-indigo-600 underline" href={r.url} target="_blank" rel="noreferrer">링크</a></> : null}{r.locations.length > 0 && <ul className="list-[circle] pl-5 text-slate-600">{r.locations.map((l, j) => (<li key={j}>{l.where}: {l.claimKo}</li>))}</ul>}{r.locations.length === 0 && <div className="text-amber-700">{r.accessNoteKo}</div>}</li>) : null; })}</ul></div>
            {m.table && (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] border border-slate-200"><thead className="bg-slate-50"><tr>{m.table.header.map((h) => <th key={h} className="p-1 text-left border-b">{h}</th>)}</tr></thead><tbody>{m.table.rows.map((r, i) => <tr key={i} className="border-t">{r.map((c, j) => <td key={j} className="p-1 align-top">{c}</td>)}</tr>)}</tbody></table>
              </div>
            )}
            <div><b>적용 한계</b><ul className="list-disc pl-5">{m.limitsKo.map((l, i) => (<li key={i}>{l}</li>))}</ul></div>
          </div>
        </details>
      ))}
      <details className="text-xs">
        <summary className="cursor-pointer font-medium">참고문헌 (APA 7판) 및 열람 상태</summary>
        <ul className="mt-2 space-y-2">
          {references.map((r) => (
            <li key={r.key}>
              <div>{r.apa.replace(/\*/g, "")}{r.url ? <> <a className="text-indigo-600 underline" href={r.url} target="_blank" rel="noreferrer">링크</a></> : null}</div>
              <div className="text-slate-500">열람 상태: {accessLabel(r.access)} — {r.accessNoteKo}</div>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
function accessLabel(a: Reference["access"]): string {
  return { FULL_TEXT_READ: "전문 열람", ABSTRACT_ONLY: "초록·서지만 확인", NOT_ACCESSED: "원문 미열람", SECONDARY_ONLY: "2차 인용으로만 확인", DOCUMENTATION_READ: "공식 문서 열람" }[a];
}

function HistorySection({ history, current }: { history: HistoryRow[]; current: string | null }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
      <h3 className="font-semibold">분석 이력 (날짜·버전)</h3>
      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-left"><tr><th className="p-1.5">실행 시각</th><th>엔진 버전</th><th>상태</th><th>화면 표시</th><th>ZIP</th></tr></thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.id} className="border-t">
              <td className="p-1.5">{dt(h.startedAt)}</td><td>{h.algorithmVersion}</td><td>{h.executionStatus}{h.errorCode ? ` (${h.errorCode})` : ""}</td>
              <td>{h.id === current ? "현재 표시 중" : h.current ? "최신 아님" : "표시 안 함"}</td><td>{h.hasPackage ? "있음" : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-slate-500">이전(오류 확인된) 방식의 결과는 검증된 재분석 후 삭제·교체되며 화면·API·다운로드에 남기지 않습니다.</p>
    </section>
  );
}
