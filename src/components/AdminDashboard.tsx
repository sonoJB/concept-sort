"use client";

import { useState } from "react";
import { ConceptMap, type ConceptPoint } from "@/components/ConceptMap";

type Statement = { id: string; text: string };

type AnalysisResponse = {
  submissionCount: number;
  clusterCount?: number;
  points: ConceptPoint[];
  clusters: { clusterId: number; statementIds: string[] }[];
};

export function AdminDashboard({
  slug,
  adminToken,
  title,
  prompt,
  initialStatements,
  initialSubmissionCount,
}: {
  slug: string;
  adminToken: string;
  title: string;
  prompt: string;
  initialStatements: Statement[];
  initialSubmissionCount: number;
}) {
  const [statements, setStatements] = useState(initialStatements);
  const [newStatement, setNewStatement] = useState("");
  const [submissionCount, setSubmissionCount] = useState(initialSubmissionCount);
  const [copied, setCopied] = useState(false);
  const [clusterCount, setClusterCount] = useState<number | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const participantUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/p/${slug}/sort`
      : `/p/${slug}/sort`;

  const locked = submissionCount > 0;

  async function refreshSubmissionCount() {
    const res = await fetch(`/api/projects/${slug}/sorts`);
    if (res.ok) {
      const data = await res.json();
      setSubmissionCount(data.submissionCount);
    }
  }

  async function loadAnalysis(k?: number) {
    setLoadingAnalysis(true);
    setError(null);
    try {
      const url = new URL(`/api/projects/${slug}/analysis`, window.location.origin);
      url.searchParams.set("token", adminToken);
      if (k) url.searchParams.set("k", String(k));
      const res = await fetch(url.toString());
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "분석에 실패했습니다.");
        setLoadingAnalysis(false);
        return;
      }
      setAnalysis(data);
      setClusterCount(data.clusterCount ?? null);
    } catch {
      setError("네트워크 오류가 발생했습니다.");
    } finally {
      setLoadingAnalysis(false);
    }
  }

  async function addStatement() {
    const text = newStatement.trim();
    if (!text) return;
    const res = await fetch(`/api/projects/${slug}/statements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, adminToken }),
    });
    const data = await res.json();
    if (res.ok) {
      setStatements((prev) => [...prev, data]);
      setNewStatement("");
    } else {
      setError(data.error ?? "추가에 실패했습니다.");
    }
  }

  async function deleteStatement(id: string) {
    const res = await fetch(`/api/projects/${slug}/statements`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ statementId: id, adminToken }),
    });
    if (res.ok) {
      setStatements((prev) => prev.filter((s) => s.id !== id));
    }
  }

  function copyLink() {
    navigator.clipboard.writeText(participantUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="max-w-4xl mx-auto py-10 px-4 space-y-10">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        {prompt && <p className="text-slate-600 mt-1">{prompt}</p>}
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">참가자 링크</h2>
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={participantUrl}
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono bg-slate-50"
          />
          <button
            onClick={copyLink}
            className="rounded-lg bg-slate-900 px-4 py-2 text-white text-sm font-medium hover:bg-slate-700"
          >
            {copied ? "복사됨" : "복사"}
          </button>
        </div>
        <p className="text-sm text-slate-500">
          제출 수: <span className="font-medium text-slate-700">{submissionCount}</span>{" "}
          <button onClick={refreshSubmissionCount} className="underline">
            새로고침
          </button>
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          진술문 목록 ({statements.length}개)
        </h2>
        {locked && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            이미 제출된 응답이 있어 진술문을 추가/삭제할 수 없습니다. 목록을
            변경하면 기존 결과와의 일관성이 깨질 수 있습니다.
          </p>
        )}
        <ul className="space-y-1.5">
          {statements.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm"
            >
              <span>{s.text}</span>
              {!locked && (
                <button
                  onClick={() => deleteStatement(s.id)}
                  className="text-slate-400 hover:text-red-500 text-xs"
                >
                  삭제
                </button>
              )}
            </li>
          ))}
        </ul>
        {!locked && (
          <div className="flex gap-2">
            <input
              value={newStatement}
              onChange={(e) => setNewStatement(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addStatement()}
              placeholder="새 진술문 추가"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <button
              onClick={addStatement}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100"
            >
              추가
            </button>
          </div>
        )}
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">결과 · 개념도</h2>
          <button
            onClick={() => loadAnalysis()}
            disabled={loadingAnalysis}
            className="rounded-lg bg-slate-900 px-4 py-2 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
          >
            {loadingAnalysis ? "계산 중..." : "결과 보기"}
          </button>
        </div>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        {analysis && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <label htmlFor="k" className="text-sm text-slate-600">
                군집 수
              </label>
              <input
                id="k"
                type="range"
                min={2}
                max={Math.max(2, statements.length - 1)}
                value={clusterCount ?? 2}
                onChange={(e) => {
                  const k = Number(e.target.value);
                  setClusterCount(k);
                  loadAnalysis(k);
                }}
                className="flex-1"
              />
              <span className="text-sm font-medium w-6 text-center">
                {clusterCount ?? "-"}
              </span>
            </div>

            <ConceptMap points={analysis.points} />
          </div>
        )}
      </section>
    </div>
  );
}
