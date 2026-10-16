"use client";

import { useEffect, useState } from "react";

type Scope = "ALL" | "KR" | "JP";

type Summary = {
  nTotal: number;
  nKr: number;
  nJp: number;
  exclusionCounts: Record<string, number>;
  generatedAt: string;
};

const ITEMS: { scope: Scope; title: string; sub: string; primary: boolean }[] = [
  { scope: "ALL", title: "본조사 유사성 행렬 — 전체", sub: "전체(한국+일본)", primary: true },
  { scope: "KR", title: "본조사 유사성 행렬 — 한국", sub: "한국(KR)", primary: false },
  { scope: "JP", title: "본조사 유사성 행렬 — 일본", sub: "일본(JP)", primary: false },
];

function fileNameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // fall through
    }
  }
  const plain = header.match(/filename="([^"]+)"/i);
  return plain ? plain[1] : fallback;
}

/**
 * Three independent official 본조사 similarity-matrix downloads. Each button
 * passes ITS OWN scope explicitly to the server; nothing here reads the
 * participant-table filter or any other screen state, and the study phase is
 * not selectable (the server always uses 본조사 = MAIN only).
 */
export default function OfficialMatrixDownloads({ slug, adminToken }: { slug: string; adminToken: string }) {
  const [summaries, setSummaries] = useState<Partial<Record<Scope, Summary>>>({});
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [busyScope, setBusyScope] = useState<Scope | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const entries = await Promise.all(
          (["ALL", "KR", "JP"] as Scope[]).map(async (scope) => {
            const res = await fetch(
              `/api/projects/${encodeURIComponent(slug)}/official-matrix?scope=${scope}&format=json`,
              { headers: { "x-admin-token": adminToken }, cache: "no-store" }
            );
            if (!res.ok) throw new Error(String(res.status));
            return [scope, (await res.json()) as Summary] as const;
          })
        );
        if (!cancelled) setSummaries(Object.fromEntries(entries));
      } catch {
        if (!cancelled) setSummaryError("유효 참여자 수를 불러오지 못했습니다. (다운로드는 계속 사용할 수 있습니다.)");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, adminToken]);

  async function download(scope: Scope) {
    setError(null);
    setBusyScope(scope);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(slug)}/official-matrix?scope=${scope}&dataset=MAIN`,
        { headers: { "x-admin-token": adminToken }, cache: "no-store" }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "행렬 파일을 만들지 못했습니다.");
        return;
      }
      const blob = await res.blob();
      const name = fileNameFromDisposition(res.headers.get("Content-Disposition"), `main_study_matrix_${scope}.xlsx`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      setError("네트워크 오류가 발생했습니다.");
    } finally {
      setBusyScope(null);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
      <div>
        <h3 className="font-semibold">본조사 유사성 행렬 다운로드 (Excel)</h3>
        <p className="text-xs text-slate-500 mt-1">
          세 파일은 서로 독립적입니다. 어떤 버튼이든 항상 <b>조사 단계 = 본조사</b>만 포함하며(파일럿·테스트 제외),
          아래 참가자 목록의 필터나 다른 화면의 선택과 무관하게 버튼에 적힌 국가 범위로만 만들어집니다.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {ITEMS.map((item) => {
          const s = summaries[item.scope];
          const empty = s !== undefined && s.nTotal === 0;
          return (
            <div key={item.scope} className="rounded-lg border border-slate-200 p-3 space-y-2">
              <div className="text-sm font-medium">{item.title}</div>
              <div className="text-xs text-slate-500">
                {s === undefined
                  ? summaryError
                    ? "유효 N 확인 불가"
                    : "유효 N 확인 중…"
                  : empty
                    ? "대상 본조사 완료자 없음"
                    : item.scope === "ALL"
                      ? `유효 N = ${s.nTotal} (한국 ${s.nKr} + 일본 ${s.nJp})`
                      : `유효 N = ${s.nTotal}`}
              </div>
              <button
                onClick={() => download(item.scope)}
                disabled={busyScope !== null}
                data-scope={item.scope}
                className={
                  item.primary
                    ? "w-full rounded-lg bg-slate-900 px-3 py-2 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
                    : "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
                }
              >
                {busyScope === item.scope ? "생성 중..." : `${item.sub} 다운로드 (.xlsx)`}
              </button>
            </div>
          );
        })}
      </div>
      {summaryError && <p className="text-xs text-amber-700">{summaryError}</p>}
      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
      )}
    </div>
  );
}
