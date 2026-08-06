"use client";

import { useState } from "react";
import Link from "next/link";
import { SortBoard } from "@/components/SortBoard";
import type { LocaleContentStatus } from "@/lib/localeContentStatus";
import type { ParticipantLocale } from "@/messages/participant";

const BANNER_TEXT: Record<ParticipantLocale, string> = {
  ko: "미리보기 모드 — 실제 응답은 저장되지 않습니다.",
  ja: "プレビューモード — 回答は保存されません。",
};
const CONFIRM_LABEL: Record<ParticipantLocale, string> = {
  ko: "이 화면을 확인했습니다",
  ja: "この画面を確認しました",
};
const BACK_LABEL: Record<ParticipantLocale, string> = {
  ko: "관리자 준비 상태로 돌아가기",
  ja: "管理者の準備状況に戻る",
};
const NOT_READY_HEADING: Record<ParticipantLocale, string> = {
  ko: "아직 미리보기를 표시할 수 없습니다 (관리자 전용 안내)",
  ja: "プレビューを表示できません（管理者専用の案内）",
};

export function PreviewClient({
  slug,
  adminToken,
  locale,
  status,
  boardProps,
}: {
  slug: string;
  adminToken: string;
  locale: ParticipantLocale;
  status: LocaleContentStatus;
  boardProps: Omit<
    React.ComponentProps<typeof SortBoard>,
    "previewMode" | "previewLocale" | "koreanAvailable" | "japaneseAvailable"
  >;
}) {
  const [confirming, setConfirming] = useState(false);
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  async function confirmPreview() {
    setConfirming(true);
    setConfirmError(null);
    try {
      const res = await fetch(`/api/projects/${slug}/preview-confirmation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminToken, locale, confirmed: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        setConfirmError(data.error ?? "확인 처리에 실패했습니다.");
        return;
      }
      setConfirmedAt(locale === "ko" ? data.koPreviewConfirmedAt : data.jaPreviewConfirmedAt);
    } catch {
      setConfirmError("네트워크 오류가 발생했습니다.");
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="min-h-dvh flex flex-col">
      <div className="shrink-0 bg-amber-500 text-white text-center text-sm font-medium py-2 px-4">
        {BANNER_TEXT[locale]}
      </div>

      {!status.ready ? (
        <div className="max-w-xl mx-auto py-16 px-4 space-y-4">
          <h1 className="text-lg font-bold">{NOT_READY_HEADING[locale]}</h1>
          <ul className="list-disc pl-5 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-4 space-y-1">
            {status.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          <Link href={`/p/${slug}/admin/${adminToken}?tab=readiness`} className="text-sm underline">
            {BACK_LABEL[locale]}
          </Link>
        </div>
      ) : (
        <>
          <SortBoard
            {...boardProps}
            previewMode
            previewLocale={locale}
            koreanAvailable={locale === "ko"}
            japaneseAvailable={locale === "ja"}
          />
          <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-3 flex flex-wrap items-center gap-3 justify-center">
            <button
              onClick={confirmPreview}
              disabled={confirming || Boolean(confirmedAt)}
              className="rounded-lg bg-slate-900 px-5 py-2.5 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
            >
              {confirmedAt ? `✓ ${CONFIRM_LABEL[locale]}` : CONFIRM_LABEL[locale]}
            </button>
            <Link
              href={`/p/${slug}/admin/${adminToken}?tab=readiness`}
              className="text-sm underline text-slate-600"
            >
              {BACK_LABEL[locale]}
            </Link>
            {confirmError && <p className="text-sm text-red-600">{confirmError}</p>}
          </div>
        </>
      )}
    </div>
  );
}
