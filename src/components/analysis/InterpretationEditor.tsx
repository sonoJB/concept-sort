"use client";

import { useState } from "react";
import { analysisApi } from "./api";
import { isInterpretationEditorDisabled } from "@/lib/analysis/view/uiState";

type Interpretation = {
  id: string;
  status: string;
  version: number;
  selectedClusterCount: number;
  axisLabels: string | null;
  quadrantLabels: string | null;
  notes: string | null;
};

export function InterpretationEditor({
  slug,
  adminToken,
  interpretation,
  onChanged,
  onFinalizeConfirm,
}: {
  slug: string;
  adminToken: string;
  interpretation: Interpretation;
  onChanged: () => void;
  onFinalizeConfirm: () => boolean;
}) {
  const api = analysisApi(slug, adminToken);
  const isDraft = !isInterpretationEditorDisabled(interpretation.status);
  const [axisLabels, setAxisLabels] = useState(interpretation.axisLabels ?? "");
  const [quadrantLabels, setQuadrantLabels] = useState(interpretation.quadrantLabels ?? "");
  const [notes, setNotes] = useState(interpretation.notes ?? "");
  const [labelKo, setLabelKo] = useState("");
  const [labelClusterIndex, setLabelClusterIndex] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(patch: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const res = await api.patchInterpretation(interpretation.id, patch);
    setBusy(false);
    if (!res.ok) {
      setError(res.body?.errorCode === "INTERPRETATION_FINALIZED" ? "이미 확정된 해석본은 수정할 수 없습니다." : "저장에 실패했습니다.");
      return;
    }
    onChanged();
  }

  async function finalize() {
    if (!onFinalizeConfirm()) return;
    await save({ status: "FINALIZED" });
  }

  async function saveLabel() {
    if (!labelKo.trim()) return;
    setBusy(true);
    setError(null);
    const res = await api.saveLabel(interpretation.id, labelClusterIndex, "ko", labelKo.trim());
    setBusy(false);
    if (!res.ok) {
      setError("군집 라벨 저장에 실패했습니다.");
      return;
    }
    setLabelKo("");
    onChanged();
  }

  return (
    <div className="rounded-xl border border-slate-200 p-4 space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">
          해석본 v{interpretation.version} (k={interpretation.selectedClusterCount})
        </h3>
        <span
          className={`text-xs rounded-full px-2 py-0.5 ${isDraft ? "bg-amber-100 text-amber-700" : "bg-green-100 text-green-700"}`}
        >
          {isDraft ? "DRAFT" : "FINALIZED"}
        </span>
      </div>

      {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-2 py-1.5">{error}</p>}

      <div className="space-y-2">
        <label className="block text-xs text-slate-500">
          축 라벨 (선택)
          <input
            value={axisLabels}
            disabled={!isDraft}
            onChange={(e) => setAxisLabels(e.target.value)}
            onBlur={() => isDraft && save({ axisLabels })}
            className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1 text-sm disabled:bg-slate-50 disabled:text-slate-400"
          />
        </label>
        <label className="block text-xs text-slate-500">
          사분면 라벨 (선택)
          <input
            value={quadrantLabels}
            disabled={!isDraft}
            onChange={(e) => setQuadrantLabels(e.target.value)}
            onBlur={() => isDraft && save({ quadrantLabels })}
            className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1 text-sm disabled:bg-slate-50 disabled:text-slate-400"
          />
        </label>
        <label className="block text-xs text-slate-500">
          메모
          <textarea
            value={notes}
            disabled={!isDraft}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => isDraft && save({ notes })}
            rows={2}
            className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1 text-sm disabled:bg-slate-50 disabled:text-slate-400"
          />
        </label>
      </div>

      {isDraft && (
        <div className="flex items-end gap-2 border-t border-slate-100 pt-3">
          <label className="text-xs text-slate-500">
            군집 번호
            <input
              type="number"
              min={1}
              max={interpretation.selectedClusterCount}
              value={labelClusterIndex}
              onChange={(e) => setLabelClusterIndex(Number(e.target.value))}
              className="mt-1 w-16 rounded-lg border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="flex-1 text-xs text-slate-500">
            군집 라벨 (한국어)
            <input
              value={labelKo}
              onChange={(e) => setLabelKo(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          <button
            disabled={busy}
            onClick={saveLabel}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
          >
            저장
          </button>
        </div>
      )}

      {isDraft && (
        <button
          disabled={busy}
          onClick={finalize}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          최종 확정
        </button>
      )}
    </div>
  );
}
