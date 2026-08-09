"use client";

import { useEffect, useState } from "react";

export function DeleteConfirmModal({
  title,
  message,
  confirmLabel,
  requireTypedConfirmation,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  /** When set, the confirm button stays disabled until the admin types this exact string. */
  requireTypedConfirmation?: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (typedValue?: string) => void;
}) {
  const [typed, setTyped] = useState("");

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  const typedOk = !requireTypedConfirmation || typed === requireTypedConfirmation;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-confirm-title"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-5 space-y-4 shadow-xl">
        <h2 id="delete-confirm-title" className="text-lg font-bold text-red-700">
          {title}
        </h2>
        <p className="text-sm text-slate-700 whitespace-pre-line leading-relaxed">{message}</p>

        {requireTypedConfirmation && (
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              계속하려면 아래 문구를 정확히 입력하세요
            </label>
            <p className="text-xs font-mono bg-slate-50 border border-slate-200 rounded px-2 py-1 mb-1.5 break-all">
              {requireTypedConfirmation}
            </p>
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="w-full min-w-0 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
          >
            취소
          </button>
          <button
            onClick={() => onConfirm(typed)}
            disabled={busy || !typedOk}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? "삭제 중..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
