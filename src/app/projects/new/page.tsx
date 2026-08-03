"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function NewProjectPage() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [statementsText, setStatementsText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const statementCount = statementsText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const statements = statementsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, prompt, statements }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "프로젝트 생성에 실패했습니다.");
        setSubmitting(false);
        return;
      }
      router.push(`/p/${data.slug}/admin/${data.adminToken}`);
    } catch {
      setError("네트워크 오류가 발생했습니다.");
      setSubmitting(false);
    }
  }

  return (
    <main className="flex-1 px-6 py-12">
      <div className="max-w-2xl mx-auto space-y-8">
        <div>
          <h1 className="text-2xl font-bold">새 프로젝트 만들기</h1>
          <p className="text-slate-600 mt-1">
            참가자들이 분류할 진술문(카드)을 등록하세요. 한 줄에 하나씩
            입력하면 됩니다.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="title" className="block text-sm font-medium mb-1">
              프로젝트 제목
            </label>
            <input
              id="title"
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="예: 청소년 진로 인식 개념도 연구"
              className="w-full rounded-lg border border-slate-300 px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
          </div>

          <div>
            <label htmlFor="prompt" className="block text-sm font-medium mb-1">
              참가자 안내문 (선택)
            </label>
            <textarea
              id="prompt"
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="예: 아래 카드들을 의미상 비슷하다고 느끼는 것끼리 자유롭게 묶어 주세요."
              className="w-full rounded-lg border border-slate-300 px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
          </div>

          <div>
            <label
              htmlFor="statements"
              className="block text-sm font-medium mb-1"
            >
              진술문 목록 ({statementCount}개)
            </label>
            <textarea
              id="statements"
              required
              rows={10}
              value={statementsText}
              onChange={(e) => setStatementsText(e.target.value)}
              placeholder={"진술문1\n진술문2\n진술문3\n..."}
              className="w-full rounded-lg border border-slate-300 px-4 py-2.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
            <p className="text-xs text-slate-500 mt-1">
              최소 2개 이상 입력해 주세요.
            </p>
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-slate-900 px-6 py-3 text-white font-medium hover:bg-slate-700 transition-colors disabled:opacity-50"
          >
            {submitting ? "생성 중..." : "프로젝트 생성"}
          </button>
        </form>
      </div>
    </main>
  );
}
