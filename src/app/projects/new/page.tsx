"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const DEFAULT_TITLE = "Characteristics of Cyberbullying";

const DEFAULT_PROMPT = `청소년이 인식한 사이버폭력의 특징에 대한 유사성 분류를 진행하고자 합니다. 제시된 유사성 분류 카드(진술문 목록)를 보시고 귀하께서 생각하시기에 유사한 내용의 카드(진술문)를 같은 묶음으로 분류하시기 바랍니다. 분류하는 기준에는 정답이 없습니다. 유사하다고 생각되는 카드(진술문)을 묶음으로 분류해 주시면 됩니다. 15분 내외의 시간이 소요될 수 있습니다.

※ 유사성 분류 작업 시, 다음의 5가지 지침을 반드시 준수해 주십시오.
① 하나의 묶음은 반드시 2장 이상의 카드로 구성되어야 합니다.
② 모든 카드를 하나의 묶음으로 만들 수는 없습니다. (전체 카드 47장을 하나의 묶음으로 불가)
③ 하나의 묶음에는 16장 이상의 카드가 포함될 수 없습니다. 전체 카드의 1/3 이상이 포함된 묶음이 만들어지지 않기 위함입니다.
④ 남는 카드 간 유사성(공통점)이 없을 때, <기타>라는 묶음으로 몽땅 묶일 수 없습니다. 번거로우시겠지만 다른 주제(묶음 제목)를 생각해 보셔야 합니다. (유사성이 있는 카드끼리만 묶음을 만들 수 있습니다.)
⑤ 누락되는 카드(진술문)가 없도록 유의해 주세요. (47장의 모든 카드는 하나 이상의 묶음에 포함되어야 합니다.)
- 최소: 4개 묶음(카드 2장으로 구성된 1개 묶음, 카드 15장으로 구성된 3개 묶음)
- 최대: 23개 묶음(카드 2장으로 구성된 22개 묶음, 카드 3장으로 구성된 1개 묶음)`;

export default function NewProjectPage() {
  const router = useRouter();
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [statementsText, setStatementsText] = useState("");
  const [wantKorean, setWantKorean] = useState(true);
  const [wantJapanese, setWantJapanese] = useState(false);
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
      const nextTab = !wantKorean && wantJapanese ? "ja" : "ko";
      router.push(`/p/${data.slug}/admin/${data.adminToken}?tab=${nextTab}`);
    } catch {
      setError("네트워크 오류가 발생했습니다.");
      setSubmitting(false);
    }
  }

  return (
    <main className="flex-1 px-6 py-12">
      <div className="max-w-2xl mx-auto space-y-8">
        <div>
          <h1 className="text-2xl font-bold">새 프로젝트 만들기 (1단계: 초안)</h1>
          <p className="text-slate-600 mt-1">
            내부 관리용 한국어 제목과 진술문으로 초안을 생성합니다. 참가자에게
            공개되는 언어별 화면(제목/안내/동의서)은 생성 후 관리자 화면의
            한국어·日本語 탭에서 별도로 작성하고 활성화합니다.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-sm font-medium mb-1.5">
              향후 작성할 언어 (관리자 탭 안내용 — 참가자 공개와는 무관합니다)
            </label>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={wantKorean}
                  onChange={(e) => setWantKorean(e.target.checked)}
                />
                한국어 자료 작성
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={wantJapanese}
                  onChange={(e) => setWantJapanese(e.target.checked)}
                />
                日本語 자료 작성
              </label>
            </div>
          </div>

          <div>
            <label htmlFor="title" className="block text-sm font-medium mb-1">
              내부 관리용 한국어 연구 제목
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
              참가자 안내문
            </label>
            <p className="text-xs text-slate-500 mb-1.5">
              연구자가 자유롭게 수정할 수 있습니다. 프로젝트를 생성하고 링크를
              공유한 뒤에는 참가자가 이 내용을 수정할 수 없습니다.
            </p>
            <textarea
              id="prompt"
              rows={16}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="예: 아래 카드들을 의미상 비슷하다고 느끼는 것끼리 자유롭게 묶어 주세요."
              className="w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
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
            {submitting ? "생성 중..." : "초안 생성 (한국어·日本語 모두 비활성 상태로 시작)"}
          </button>
        </form>
      </div>
    </main>
  );
}
