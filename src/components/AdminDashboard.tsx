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

type Participant = {
  id: string;
  participantName: string;
  consentAgreed: boolean;
  gender: string;
  age: number;
  schoolLevel: string;
  grade: string;
  phoneNumber: string;
  submittedAt: string;
  groups: { label: string; statementNumbers: number[] }[];
};

function formatGroups(groups: Participant["groups"]): string {
  return groups
    .map((g, i) => `${g.label || `묶음${i + 1}`}: [${g.statementNumbers.join(",")}]`)
    .join(" | ");
}

function toCsv(rows: string[][]): string {
  return rows
    .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob(["﻿" + content], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

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
  const [participants, setParticipants] = useState<Participant[] | null>(null);
  const [loadingParticipants, setLoadingParticipants] = useState(false);
  const [participantsError, setParticipantsError] = useState<string | null>(
    null
  );
  const [loadingMatrix, setLoadingMatrix] = useState(false);
  const [matrixError, setMatrixError] = useState<string | null>(null);

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

  async function loadParticipants(): Promise<Participant[] | null> {
    setLoadingParticipants(true);
    setParticipantsError(null);
    try {
      const url = new URL(
        `/api/projects/${slug}/participants`,
        window.location.origin
      );
      url.searchParams.set("token", adminToken);
      const res = await fetch(url.toString());
      const data = await res.json();
      if (!res.ok) {
        setParticipantsError(data.error ?? "참가자 목록을 불러오지 못했습니다.");
        return null;
      }
      setParticipants(data.participants);
      return data.participants;
    } catch {
      setParticipantsError("네트워크 오류가 발생했습니다.");
      return null;
    } finally {
      setLoadingParticipants(false);
    }
  }

  async function handleDownloadCsv() {
    const rows = participants ?? (await loadParticipants());
    if (!rows) return;

    const header = [
      "번호",
      "이름",
      "동의여부",
      "성별",
      "연령",
      "학교급",
      "학년",
      "전화번호",
      "제출일시",
      "묶음수",
      "분류결과(진술문 번호)",
    ];
    const body = rows.map((p, i) => [
      String(i + 1),
      p.participantName,
      p.consentAgreed ? "동의" : "미동의",
      p.gender,
      String(p.age),
      p.schoolLevel,
      p.grade,
      p.phoneNumber,
      p.submittedAt,
      String(p.groups.length),
      formatGroups(p.groups),
    ]);

    downloadCsv(`${slug}_participants.csv`, toCsv([header, ...body]));
  }

  async function handleDownloadMatrixCsv() {
    setMatrixError(null);
    setLoadingMatrix(true);
    try {
      const url = new URL(`/api/projects/${slug}/matrix`, window.location.origin);
      url.searchParams.set("token", adminToken);
      const res = await fetch(url.toString());
      const data = await res.json();
      if (!res.ok) {
        setMatrixError(data.error ?? "집단행렬을 불러오지 못했습니다.");
        return;
      }

      const labels: string[] = data.statements.map(
        (s: { number: number }) => String(s.number)
      );
      const header = ["구분", ...labels];
      const body: string[][] = data.matrix.map((row: number[], i: number) => [
        labels[i],
        ...row.map((v) => String(v)),
      ]);

      const legendHeader = ["번호", "진술문"];
      const legendBody: string[][] = data.statements.map(
        (s: { number: number; text: string }) => [String(s.number), s.text]
      );

      const csv = [
        toCsv([header, ...body]),
        "",
        toCsv([legendHeader, ...legendBody]),
      ].join("\r\n");

      downloadCsv(`${slug}_group_matrix.csv`, csv);
    } catch {
      setMatrixError("네트워크 오류가 발생했습니다.");
    } finally {
      setLoadingMatrix(false);
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
          <div className="flex gap-2">
            <button
              onClick={() => loadAnalysis()}
              disabled={loadingAnalysis}
              className="rounded-lg bg-slate-900 px-4 py-2 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
            >
              {loadingAnalysis ? "계산 중..." : "결과 보기"}
            </button>
            <button
              onClick={handleDownloadMatrixCsv}
              disabled={loadingMatrix}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
            >
              {loadingMatrix ? "생성 중..." : "집단행렬 CSV 다운로드"}
            </button>
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        {matrixError && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {matrixError}
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

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">참가자 목록</h2>
          <div className="flex gap-2">
            <button
              onClick={() => loadParticipants()}
              disabled={loadingParticipants}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
            >
              {loadingParticipants ? "불러오는 중..." : "참가자 목록 보기"}
            </button>
            <button
              onClick={handleDownloadCsv}
              disabled={loadingParticipants}
              className="rounded-lg bg-slate-900 px-4 py-2 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
            >
              CSV 다운로드
            </button>
          </div>
        </div>

        {participantsError && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {participantsError}
          </p>
        )}

        {participants && (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-sm whitespace-nowrap">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">이름</th>
                  <th className="text-left px-3 py-2 font-medium">성별</th>
                  <th className="text-left px-3 py-2 font-medium">연령</th>
                  <th className="text-left px-3 py-2 font-medium">학교급</th>
                  <th className="text-left px-3 py-2 font-medium">학년</th>
                  <th className="text-left px-3 py-2 font-medium">전화번호</th>
                  <th className="text-left px-3 py-2 font-medium">제출일시</th>
                  <th className="text-left px-3 py-2 font-medium">분류결과</th>
                </tr>
              </thead>
              <tbody>
                {participants.map((p) => (
                  <tr key={p.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">{p.participantName}</td>
                    <td className="px-3 py-2">{p.gender}</td>
                    <td className="px-3 py-2">{p.age}</td>
                    <td className="px-3 py-2">{p.schoolLevel}</td>
                    <td className="px-3 py-2">{p.grade}</td>
                    <td className="px-3 py-2">{p.phoneNumber}</td>
                    <td className="px-3 py-2">
                      {new Date(p.submittedAt).toLocaleString("ko-KR")}
                    </td>
                    <td className="px-3 py-2 whitespace-normal">
                      {formatGroups(p.groups)}
                    </td>
                  </tr>
                ))}
                {participants.length === 0 && (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-3 py-6 text-center text-slate-400"
                    >
                      아직 제출된 응답이 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
