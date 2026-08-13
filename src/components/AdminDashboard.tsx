"use client";

import { useEffect, useState } from "react";
import { DeleteConfirmModal } from "@/components/DeleteConfirmModal";
import { AnalysisPanel } from "@/components/analysis/AnalysisPanel";
import { toCsv, downloadCsv } from "@/lib/csv";
import { JA_RESPONSIBLE_PARTY_NOTICE } from "@/lib/consent";
import type { LocaleContentStatus, OperatingState } from "@/lib/localeContentStatus";
import { validateNonBlankLines, splitBulkLines } from "@/lib/statementLines";
import {
  computeGuideTemplateVariables,
  defaultGuideTemplateFor,
  findUnknownTemplateVariables,
  renderGuideTemplate,
} from "@/lib/guideTemplate";

type Statement = {
  id: string;
  text: string;
  order: number;
  textJa: string | null;
  jaStatus: string;
};

type Participant = {
  id: string;
  countryCode: string | null;
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

const JA_STATUS_LABELS: Record<string, string> = {
  MISSING: "미작성",
  DRAFT: "초안",
  REVIEWING: "검토 중",
  APPROVED: "승인",
};

function countryLabel(countryCode: string | null): string {
  if (countryCode === "KR") return "Korea (한국)";
  if (countryCode === "JP") return "Japan (日本)";
  return "미지정";
}

function formatGroups(groups: Participant["groups"]): string {
  return groups
    .map((g, i) => `${g.label || `묶음${i + 1}`}: [${g.statementNumbers.join(",")}]`)
    .join(" | ");
}

type Tab = "ko" | "ja" | "readiness" | "analysis" | "participants";

export function AdminDashboard({
  slug,
  adminToken,
  title,
  prompt,
  titleJa,
  promptJa,
  consentKo,
  consentJa,
  guideTemplateKo,
  guideTemplateJa,
  koreanEnabled,
  japaneseEnabled,
  legacyConsentFallbackEnabled,
  koPreviewConfirmedAt,
  jaPreviewConfirmedAt,
  initialStatements,
  initialSubmissionCount,
  initialTab = "ko",
}: {
  slug: string;
  adminToken: string;
  title: string;
  prompt: string;
  titleJa: string | null;
  promptJa: string | null;
  consentKo: string | null;
  consentJa: string | null;
  guideTemplateKo: string | null;
  guideTemplateJa: string | null;
  koreanEnabled: boolean;
  japaneseEnabled: boolean;
  legacyConsentFallbackEnabled: boolean;
  koPreviewConfirmedAt: string | null;
  jaPreviewConfirmedAt: string | null;
  initialStatements: Statement[];
  initialSubmissionCount: number;
  initialTab?: "ko" | "ja" | "readiness";
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [statements, setStatements] = useState(initialStatements);
  const [submissionCount, setSubmissionCount] = useState(initialSubmissionCount);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [participants, setParticipants] = useState<Participant[] | null>(null);
  const [loadingParticipants, setLoadingParticipants] = useState(false);
  const [participantsError, setParticipantsError] = useState<string | null>(null);
  const [loadingMatrix, setLoadingMatrix] = useState(false);
  const [matrixError, setMatrixError] = useState<string | null>(null);
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<Set<string>>(new Set());
  const [deleteModal, setDeleteModal] = useState<
    | { kind: "single" | "selected"; sessionIds: string[] }
    | { kind: "all" }
    | null
  >(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteSuccessMessage, setDeleteSuccessMessage] = useState<string | null>(null);

  // Korean content editing
  const [koTitle, setKoTitle] = useState(title);
  const [koPrompt, setKoPrompt] = useState(prompt);
  const [koConsent, setKoConsent] = useState(consentKo ?? "");
  const [koPreview, setKoPreview] = useState(koPreviewConfirmedAt);
  const [koSaving, setKoSaving] = useState(false);
  const [koSaveError, setKoSaveError] = useState<string | null>(null);
  const [koSavedAt, setKoSavedAt] = useState<number | null>(null);

  // Japanese content editing
  const [jaTitle, setJaTitle] = useState(titleJa ?? "");
  const [jaPrompt, setJaPrompt] = useState(promptJa ?? "");
  const [jaConsent, setJaConsent] = useState(consentJa ?? "");
  const [jaPreview, setJaPreview] = useState(jaPreviewConfirmedAt);
  const [jaSaving, setJaSaving] = useState(false);
  const [jaSaveError, setJaSaveError] = useState<string | null>(null);
  const [jaSavedAt, setJaSavedAt] = useState<number | null>(null);

  // Editable similarity-sorting guide template (stores {{VARIABLE}} template,
  // never the rendered numeric text). cardCountPreview is shared authoring
  // state only — it never changes the actual Statement rows; it just lets
  // the researcher preview the guide wording for a hypothetical card count.
  const [cardCountPreview, setCardCountPreview] = useState(() => String(initialStatements.length));
  const [koGuideTemplate, setKoGuideTemplate] = useState(guideTemplateKo ?? "");
  const [koGuideSaving, setKoGuideSaving] = useState(false);
  const [koGuideSaveError, setKoGuideSaveError] = useState<string | null>(null);
  const [koGuideSavedAt, setKoGuideSavedAt] = useState<number | null>(null);
  const [koGuideRegenConfirm, setKoGuideRegenConfirm] = useState(false);
  const [jaGuideTemplate, setJaGuideTemplate] = useState(guideTemplateJa ?? "");
  const [jaGuideSaving, setJaGuideSaving] = useState(false);
  const [jaGuideSaveError, setJaGuideSaveError] = useState<string | null>(null);
  const [jaGuideSavedAt, setJaGuideSavedAt] = useState<number | null>(null);
  const [jaGuideRegenConfirm, setJaGuideRegenConfirm] = useState(false);
  const [jaRowSaving, setJaRowSaving] = useState<string | null>(null);
  const [jaCsvText, setJaCsvText] = useState("");
  const [jaImportPlan, setJaImportPlan] = useState<{
    ok: boolean;
    errors: string[];
    warnings: string[];
    changes: {
      statementId: string;
      order: number;
      oldTextJa: string | null;
      newTextJa: string | null;
      oldJaStatus: string;
      newJaStatus: string;
      changed: boolean;
    }[];
  } | null>(null);
  const [jaImportBusy, setJaImportBusy] = useState(false);
  const [jaImportError, setJaImportError] = useState<string | null>(null);

  // Bulk Korean entry/edit — one line per Statement, numbering is content.
  const [koBulkText, setKoBulkText] = useState(() =>
    [...initialStatements]
      .sort((a, b) => a.order - b.order)
      .map((s) => s.text)
      .join("\n")
  );
  const [koBulkPreview, setKoBulkPreview] = useState<
    { order: number; id: string | null; before: string | null; after: string; changed: boolean }[] | null
  >(null);
  const [koBulkPreviewError, setKoBulkPreviewError] = useState<string | null>(null);
  const [koBulkSaving, setKoBulkSaving] = useState(false);
  const [koBulkSaveError, setKoBulkSaveError] = useState<string | null>(null);
  const [koBulkSavedCount, setKoBulkSavedCount] = useState<number | null>(null);
  const [koBulkShowConfirm, setKoBulkShowConfirm] = useState(false);

  // Bulk Japanese entry (paste 47 lines at once)
  const [jaBulkText, setJaBulkText] = useState(() => {
    const ordered = [...initialStatements].sort((a, b) => a.order - b.order);
    const hasAnyJa = ordered.some((s) => s.textJa?.trim());
    return hasAnyJa ? ordered.map((s) => s.textJa ?? "").join("\n") : "";
  });
  const [jaBulkStatus, setJaBulkStatus] = useState<"DRAFT" | "REVIEWING" | "APPROVED">("DRAFT");
  const [jaBulkAckOverwrite, setJaBulkAckOverwrite] = useState(false);
  const [jaBulkPreview, setJaBulkPreview] = useState<
    { order: number; korean: string; japanese: string }[] | null
  >(null);
  const [jaBulkPreviewError, setJaBulkPreviewError] = useState<string | null>(null);
  const [jaBulkSaving, setJaBulkSaving] = useState(false);
  const [jaBulkSaveError, setJaBulkSaveError] = useState<string | null>(null);
  const [jaBulkSavedCount, setJaBulkSavedCount] = useState<number | null>(null);
  const [jaBulkShowApprovedConfirm, setJaBulkShowApprovedConfirm] = useState(false);

  // Readiness / activation
  const [readiness, setReadiness] = useState<{ ko: LocaleContentStatus; ja: LocaleContentStatus } | null>(
    null
  );
  const [loadingReadiness, setLoadingReadiness] = useState(false);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [koEnabled, setKoEnabled] = useState(koreanEnabled);
  const [jaEnabled, setJaEnabled] = useState(japaneseEnabled);
  const [activationError, setActivationError] = useState<string | null>(null);
  const [activationBusy, setActivationBusy] = useState(false);
  const [operatingState, setOperatingState] = useState<OperatingState | null>(null);

  const participantUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/p/${slug}/sort`
      : `/p/${slug}/sort`;

  const locked = submissionCount > 0;
  const usesLegacyFallback = legacyConsentFallbackEnabled && !koConsent.trim();

  // Guide-template live preview. The actual production source of truth for
  // card count is always COUNT(Statement) — this preview input never writes
  // to Statement rows; it only lets the researcher see what the guide
  // wording would look like for a hypothetical count before/without
  // changing the real statement set.
  const actualCardCount = statements.length;
  const parsedCardCountPreview = Number(cardCountPreview);
  const cardCountPreviewValid =
    Number.isInteger(parsedCardCountPreview) && parsedCardCountPreview > 0;
  const cardCountMismatch = cardCountPreviewValid && parsedCardCountPreview !== actualCardCount;
  const previewCardCount = cardCountPreviewValid ? parsedCardCountPreview : actualCardCount;

  const koGuideVars = computeGuideTemplateVariables(previewCardCount, "ko");
  const jaGuideVars = computeGuideTemplateVariables(previewCardCount, "ja");
  const koGuideEffectiveTemplate = koGuideTemplate.trim()
    ? koGuideTemplate
    : defaultGuideTemplateFor("ko");
  const jaGuideEffectiveTemplate = jaGuideTemplate.trim()
    ? jaGuideTemplate
    : defaultGuideTemplateFor("ja");
  const koGuideRender = renderGuideTemplate(koGuideEffectiveTemplate, koGuideVars);
  const jaGuideRender = renderGuideTemplate(jaGuideEffectiveTemplate, jaGuideVars);
  const koGuideUnknownVars = findUnknownTemplateVariables(koGuideTemplate);
  const jaGuideUnknownVars = findUnknownTemplateVariables(jaGuideTemplate);

  async function refreshSubmissionCount() {
    const res = await fetch(`/api/projects/${slug}/sorts`);
    if (res.ok) {
      const data = await res.json();
      setSubmissionCount(data.submissionCount);
    }
  }

  async function loadParticipants(): Promise<Participant[] | null> {
    setLoadingParticipants(true);
    setParticipantsError(null);
    try {
      const url = new URL(`/api/projects/${slug}/participants`, window.location.origin);
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

  function toggleParticipantSelected(id: string) {
    setSelectedParticipantIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllParticipants(rows: Participant[]) {
    setSelectedParticipantIds((prev) =>
      prev.size === rows.length ? new Set() : new Set(rows.map((p) => p.id))
    );
  }

  async function performDelete(
    mode: "selected" | "all",
    sessionIds: string[],
    confirmation?: string
  ) {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/projects/${slug}/participants/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "selected"
            ? { adminToken, mode, sessionIds }
            : { adminToken, mode, confirmation }
        ),
      });
      const data = await res.json();
      if (!res.ok) {
        setDeleteError(data.error ?? "삭제에 실패했습니다.");
        return;
      }
      setDeleteSuccessMessage(
        `참여 기록 ${data.deletedSessions}건이 삭제되었습니다. (묶음 ${data.deletedGroups}개, 분류 항목 ${data.deletedGroupItems}개 함께 삭제됨)`
      );
      setSelectedParticipantIds(new Set());
      setDeleteModal(null);
      await Promise.all([loadParticipants(), refreshSubmissionCount()]);
    } catch {
      setDeleteError("네트워크 오류가 발생했습니다.");
    } finally {
      setDeleteBusy(false);
    }
  }

  async function handleDownloadCsv() {
    const rows = participants ?? (await loadParticipants());
    if (!rows) return;

    const header = [
      "번호",
      "국가",
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
      countryLabel(p.countryCode),
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

      const labels: string[] = data.statements.map((s: { number: number }) => String(s.number));
      const header = ["구분", ...labels];
      const body: string[][] = data.matrix.map((row: number[], i: number) => [
        labels[i],
        ...row.map((v) => String(v)),
      ]);

      const legendHeader = ["번호", "진술문"];
      const legendBody: string[][] = data.statements.map(
        (s: { number: number; text: string }) => [String(s.number), s.text]
      );

      const csv = [toCsv([header, ...body]), "", toCsv([legendHeader, ...legendBody])].join("\r\n");

      downloadCsv(`${slug}_group_matrix.csv`, csv);
    } catch {
      setMatrixError("네트워크 오류가 발생했습니다.");
    } finally {
      setLoadingMatrix(false);
    }
  }

  async function deleteStatement(id: string) {
    const res = await fetch(`/api/projects/${slug}/statements`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ statementId: id, adminToken }),
    });
    if (res.ok) {
      setStatements((prev) => {
        const next = prev.filter((s) => s.id !== id);
        // Re-sync both bulk textareas so their line count matches the new
        // Statement count — otherwise the next preview attempt would
        // spuriously fail the count check against stale local text.
        const ordered = [...next].sort((a, b) => a.order - b.order);
        setKoBulkText(ordered.map((s) => s.text).join("\n"));
        const hasAnyJa = ordered.some((s) => s.textJa?.trim());
        setJaBulkText(hasAnyJa ? ordered.map((s) => s.textJa ?? "").join("\n") : "");
        setKoBulkPreview(null);
        setJaBulkPreview(null);
        return next;
      });
      setKoPreview(null);
      setJaPreview(null);
      setKoEnabled(false);
      setJaEnabled(false);
    }
  }

  function copyLink() {
    navigator.clipboard.writeText(participantUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  async function saveKoContent() {
    setKoSaving(true);
    setKoSaveError(null);
    try {
      const res = await fetch(`/api/projects/${slug}/content`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adminToken,
          locale: "ko",
          title: koTitle,
          prompt: koPrompt,
          consent: koConsent,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setKoSaveError(data.error ?? "저장에 실패했습니다.");
        return;
      }
      setKoPreview(null);
      setKoEnabled(false);
      setKoSavedAt(Date.now());
    } catch {
      setKoSaveError("네트워크 오류가 발생했습니다.");
    } finally {
      setKoSaving(false);
    }
  }

  async function saveJaContent() {
    setJaSaving(true);
    setJaSaveError(null);
    try {
      const res = await fetch(`/api/projects/${slug}/content`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adminToken,
          locale: "ja",
          title: jaTitle,
          prompt: jaPrompt,
          consent: jaConsent,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setJaSaveError(data.error ?? "저장에 실패했습니다.");
        return;
      }
      setJaPreview(null);
      setJaEnabled(false);
      setJaSavedAt(Date.now());
    } catch {
      setJaSaveError("네트워크 오류가 발생했습니다.");
    } finally {
      setJaSaving(false);
    }
  }

  async function saveKoGuideTemplate() {
    setKoGuideSaving(true);
    setKoGuideSaveError(null);
    try {
      const res = await fetch(`/api/projects/${slug}/content`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminToken, locale: "ko", guideTemplate: koGuideTemplate }),
      });
      const data = await res.json();
      if (!res.ok) {
        setKoGuideSaveError(data.error ?? "저장에 실패했습니다.");
        return;
      }
      setKoPreview(null);
      setKoEnabled(false);
      setKoGuideSavedAt(Date.now());
    } catch {
      setKoGuideSaveError("네트워크 오류가 발생했습니다.");
    } finally {
      setKoGuideSaving(false);
    }
  }

  async function saveJaGuideTemplate() {
    setJaGuideSaving(true);
    setJaGuideSaveError(null);
    try {
      const res = await fetch(`/api/projects/${slug}/content`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminToken, locale: "ja", guideTemplate: jaGuideTemplate }),
      });
      const data = await res.json();
      if (!res.ok) {
        setJaGuideSaveError(data.error ?? "저장에 실패했습니다.");
        return;
      }
      setJaPreview(null);
      setJaEnabled(false);
      setJaGuideSavedAt(Date.now());
    } catch {
      setJaGuideSaveError("네트워크 오류가 발생했습니다.");
    } finally {
      setJaGuideSaving(false);
    }
  }

  function generateDefaultKoGuideTemplate() {
    if (koGuideTemplate.trim() && koGuideTemplate !== defaultGuideTemplateFor("ko")) {
      setKoGuideRegenConfirm(true);
      return;
    }
    setKoGuideTemplate(defaultGuideTemplateFor("ko"));
  }

  function generateDefaultJaGuideTemplate() {
    if (jaGuideTemplate.trim() && jaGuideTemplate !== defaultGuideTemplateFor("ja")) {
      setJaGuideRegenConfirm(true);
      return;
    }
    setJaGuideTemplate(defaultGuideTemplateFor("ja"));
  }

  async function saveJaStatement(id: string, textJa: string, jaStatus: string) {
    setJaRowSaving(id);
    try {
      const res = await fetch(`/api/projects/${slug}/statements/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminToken, textJa, jaStatus }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatements((prev) =>
          prev.map((s) => (s.id === id ? { ...s, textJa: data.textJa, jaStatus: data.jaStatus } : s))
        );
        setJaPreview(null);
        setJaEnabled(false);
      } else {
        setError(data.error ?? "일본어 진술문 저장에 실패했습니다.");
      }
    } catch {
      setError("네트워크 오류가 발생했습니다.");
    } finally {
      setJaRowSaving(null);
    }
  }

  async function runJaImport(apply: boolean) {
    setJaImportError(null);
    setJaImportBusy(true);
    try {
      const res = await fetch(`/api/projects/${slug}/statements/import-ja`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminToken, csv: jaCsvText, apply }),
      });
      const data = await res.json();
      if (!res.ok && !data.errors) {
        setJaImportError(data.error ?? "CSV 처리에 실패했습니다.");
        return;
      }
      const changes: {
        statementId: string;
        order: number;
        oldTextJa: string | null;
        newTextJa: string | null;
        oldJaStatus: string;
        newJaStatus: string;
        changed: boolean;
      }[] = data.changes ?? [];
      setJaImportPlan({ ok: data.ok, errors: data.errors ?? [], warnings: data.warnings ?? [], changes });
      if (apply && data.ok) {
        setJaPreview(null);
        setJaEnabled(false);
        // Refresh statement rows from applied changes.
        setStatements((prev) =>
          prev.map((s) => {
            const match = changes.find((c) => c.statementId === s.id && c.changed);
            return match ? { ...s, textJa: match.newTextJa, jaStatus: match.newJaStatus } : s;
          })
        );
      }
    } catch {
      setJaImportError("네트워크 오류가 발생했습니다.");
    } finally {
      setJaImportBusy(false);
    }
  }

  function buildJaBulkPreview() {
    setJaBulkSaveError(null);
    setJaBulkSavedCount(null);
    setJaBulkPreviewError(null);

    const lines = splitBulkLines(jaBulkText);
    const orderedStatements = [...statements].sort((a, b) => a.order - b.order);

    if (lines.length !== orderedStatements.length) {
      setJaBulkPreview(null);
      setJaBulkPreviewError(
        `입력된 줄 수(${lines.length})가 현재 진술문 수(${orderedStatements.length})와 일치하지 않습니다. 진술문 순서대로 한 줄에 하나씩 입력해 주세요.`
      );
      return;
    }

    const lineCheck = validateNonBlankLines(lines);
    if (!lineCheck.ok) {
      setJaBulkPreview(null);
      setJaBulkPreviewError(lineCheck.error);
      return;
    }

    setJaBulkPreview(
      orderedStatements.map((s, i) => ({ order: s.order, korean: s.text, japanese: lines[i] }))
    );
  }

  function buildKoBulkPreview() {
    setKoBulkSaveError(null);
    setKoBulkSavedCount(null);
    setKoBulkPreviewError(null);
    setKoBulkShowConfirm(false);

    const lines = splitBulkLines(koBulkText);
    const orderedStatements = [...statements].sort((a, b) => a.order - b.order);

    // A zero-statement project accepts any N >= 1 lines as the initial set;
    // an existing project must match its current Statement count exactly.
    if (orderedStatements.length > 0 && lines.length !== orderedStatements.length) {
      setKoBulkPreview(null);
      setKoBulkPreviewError(
        `입력된 줄 수(${lines.length})가 현재 진술문 수(${orderedStatements.length})와 일치하지 않습니다. 진술문 순서대로 한 줄에 하나씩 입력해 주세요.`
      );
      return;
    }

    const lineCheck = validateNonBlankLines(lines);
    if (!lineCheck.ok) {
      setKoBulkPreview(null);
      setKoBulkPreviewError(lineCheck.error);
      return;
    }

    if (orderedStatements.length === 0) {
      setKoBulkPreview(
        lines.map((line, i) => ({ order: i, id: null, before: null, after: line, changed: true }))
      );
      return;
    }

    setKoBulkPreview(
      orderedStatements.map((s, i) => ({
        order: s.order,
        id: s.id,
        before: s.text,
        after: lines[i],
        changed: lines[i] !== s.text,
      }))
    );
  }

  async function submitJaBulkSave(confirmApproved: boolean) {
    if (!jaBulkPreview) return;
    if (jaBulkStatus === "APPROVED" && !confirmApproved) {
      setJaBulkShowApprovedConfirm(true);
      return;
    }
    setJaBulkShowApprovedConfirm(false);
    setJaBulkSaving(true);
    setJaBulkSaveError(null);
    try {
      const res = await fetch(`/api/projects/${slug}/statements/bulk-import-ja`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adminToken,
          lines: jaBulkPreview.map((p) => p.japanese),
          jaStatus: jaBulkStatus,
          confirmApproved: jaBulkStatus === "APPROVED" ? true : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setJaBulkSaveError(data.error ?? "일괄 저장에 실패했습니다.");
        return;
      }
      const byId = new Map(
        (data.statements as { id: string; textJa: string | null; jaStatus: string }[]).map((s) => [s.id, s])
      );
      setStatements((prev) =>
        prev.map((s) => {
          const match = byId.get(s.id);
          return match ? { ...s, textJa: match.textJa, jaStatus: match.jaStatus } : s;
        })
      );
      setJaBulkSavedCount(data.updatedCount ?? null);
      setJaBulkPreview(null);
      setJaBulkText("");
      setJaBulkAckOverwrite(false);
      setJaPreview(null);
      setJaEnabled(false);
    } catch {
      setJaBulkSaveError("네트워크 오류가 발생했습니다.");
    } finally {
      setJaBulkSaving(false);
    }
  }

  async function submitKoBulkSave(confirmed: boolean) {
    if (!koBulkPreview) return;
    const changedCount = koBulkPreview.filter((p) => p.changed).length;
    if (changedCount === 0) {
      // Nothing changed — no DB write needed.
      setKoBulkShowConfirm(false);
      setKoBulkSavedCount(0);
      return;
    }
    if (!confirmed) {
      setKoBulkShowConfirm(true);
      return;
    }
    setKoBulkShowConfirm(false);
    setKoBulkSaving(true);
    setKoBulkSaveError(null);
    try {
      const res = await fetch(`/api/projects/${slug}/statements/bulk-update-ko`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adminToken,
          lines: koBulkPreview.map((p) => p.after),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setKoBulkSaveError(data.error ?? "일괄 저장에 실패했습니다.");
        return;
      }
      const returned = data.statements as { id: string; order: number; text: string }[];
      if (data.createdCount > 0) {
        // Zero-statement project: the returned rows are the newly created
        // Statements, complete with real IDs.
        setStatements(
          returned.map((s) => ({ id: s.id, text: s.text, order: s.order, textJa: null, jaStatus: "MISSING" }))
        );
      } else {
        const byId = new Map(returned.map((s) => [s.id, s]));
        setStatements((prev) =>
          prev.map((s) => {
            const match = byId.get(s.id);
            return match ? { ...s, text: match.text } : s;
          })
        );
      }
      setKoBulkSavedCount((data.updatedCount ?? 0) + (data.createdCount ?? 0));
      setKoBulkPreview(null);
      setKoPreview(null);
      setKoEnabled(false);
    } catch {
      setKoBulkSaveError("네트워크 오류가 발생했습니다.");
    } finally {
      setKoBulkSaving(false);
    }
  }

  function downloadJaExport() {
    const url = new URL(`/api/projects/${slug}/statements/export-ja`, window.location.origin);
    url.searchParams.set("token", adminToken);
    window.location.href = url.toString();
  }

  async function loadReadiness() {
    setLoadingReadiness(true);
    setReadinessError(null);
    try {
      const url = new URL(`/api/projects/${slug}/readiness`, window.location.origin);
      url.searchParams.set("token", adminToken);
      const res = await fetch(url.toString());
      const data = await res.json();
      if (!res.ok) {
        setReadinessError(data.error ?? "준비 상태를 불러오지 못했습니다.");
        return;
      }
      setReadiness(data);
    } catch {
      setReadinessError("네트워크 오류가 발생했습니다.");
    } finally {
      setLoadingReadiness(false);
    }
  }

  useEffect(() => {
    if (initialTab !== "readiness") return;
    const timer = setTimeout(() => loadReadiness(), 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function setLanguageEnabled(locale: "ko" | "ja", enabled: boolean) {
    setActivationBusy(true);
    setActivationError(null);
    try {
      const nextKo = locale === "ko" ? enabled : koEnabled;
      const nextJa = locale === "ja" ? enabled : jaEnabled;
      const res = await fetch(`/api/projects/${slug}/language-settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminToken, koreanEnabled: nextKo, japaneseEnabled: nextJa }),
      });
      const data = await res.json();
      if (!res.ok) {
        setActivationError(data.error ?? "활성화 상태 변경에 실패했습니다.");
        if (data.reasons) setActivationError(`${data.error}\n- ${data.reasons.join("\n- ")}`);
        return;
      }
      setKoEnabled(data.koreanEnabled);
      setJaEnabled(data.japaneseEnabled);
      setOperatingState(data.operatingState);
    } catch {
      setActivationError("네트워크 오류가 발생했습니다.");
    } finally {
      setActivationBusy(false);
    }
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "ko", label: "한국어" },
    { id: "ja", label: "日本語" },
    { id: "readiness", label: "준비 상태" },
    { id: "analysis", label: "결과·분석" },
    { id: "participants", label: "참가자" },
  ];

  return (
    <div className="max-w-4xl mx-auto py-10 px-4 space-y-8">
      <div>
        <h1 className="text-2xl font-bold">{koTitle || title}</h1>
        <p className="text-xs text-slate-400 mt-1">
          slug: {slug} · 참여 활성화 상태: 한국어 {koEnabled ? "ON" : "OFF"} / 日本語{" "}
          {jaEnabled ? "ON" : "OFF"}
        </p>
      </div>

      <div className="flex gap-1 border-b border-slate-200 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              setTab(t.id);
              if (t.id === "readiness") loadReadiness();
            }}
            className={`px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px ${
              tab === t.id
                ? "border-slate-900 text-slate-900"
                : "border-transparent text-slate-400 hover:text-slate-600"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "ko" && (
        <div className="space-y-10">
          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}
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
            <h2 className="text-lg font-semibold">한국어 연구 자료</h2>
            <div>
              <label className="block text-sm font-medium mb-1">연구 제목</label>
              <input
                value={koTitle}
                onChange={(e) => setKoTitle(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">연구 소개 및 참여 안내</label>
              <textarea
                lang="ko"
                rows={8}
                value={koPrompt}
                onChange={(e) => setKoPrompt(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                연구 참여 및 개인정보 이용 동의서
              </label>
              {usesLegacyFallback && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-1.5">
                  현재 동의서가 비어 있어 이 프로젝트에만 허용된 기존(legacy) 동의서 문안이
                  참가자에게 표시됩니다. 새 문안을 저장하면 이 문안이 우선 사용됩니다.
                </p>
              )}
              <textarea
                lang="ko"
                rows={10}
                value={koConsent}
                onChange={(e) => setKoConsent(e.target.value)}
                placeholder="동의서 문안을 입력하세요. 비워두면 참여가 차단됩니다(단, legacy 폴백이 허용된 프로젝트는 예외)."
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
              />
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={saveKoContent}
                disabled={koSaving}
                className="rounded-lg bg-slate-900 px-4 py-2 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
              >
                {koSaving ? "저장 중..." : "한국어 자료 저장"}
              </button>
              {koSavedAt && <span className="text-xs text-green-700">저장됨</span>}
              <a
                href={`/p/${slug}/preview/ko/${adminToken}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm underline text-slate-600"
              >
                한국어 화면 미리보기
              </a>
              <span className="text-xs text-slate-500">
                미리보기 확인: {koPreview ? new Date(koPreview).toLocaleString("ko-KR") : "미확인"}
              </span>
            </div>
            <p className="text-xs text-slate-500">
              미리보기 확인은 위 링크로 실제 미리보기 화면을 연 뒤, 그 화면의 확인 버튼을 눌러야
              기록됩니다.
            </p>
            {koSaveError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {koSaveError}
              </p>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">진술문 카드 수</h2>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={1}
                value={cardCountPreview}
                onChange={(e) => setCardCountPreview(e.target.value)}
                className="w-28 rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <p className="text-xs text-slate-500">
                현재 실제 저장된 진술문: <span className="font-medium text-slate-700">{actualCardCount}개</span>
              </p>
            </div>
            {cardCountMismatch && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                입력한 카드 수({parsedCardCountPreview}개)와 실제 저장된 진술문 수({actualCardCount}개)가
                일치하지 않습니다. 아래 안내문 미리보기는 입력한 카드 수 기준으로 계산되며, 실제
                진술문 개수는 변경되지 않습니다.
              </p>
            )}
            <p className="text-xs text-slate-500">
              이 입력값은 아래 안내문 미리보기 계산에만 사용되며, 실제 진술문 데이터를 변경하지
              않습니다. 진술문 개수를 실제로 바꾸려면 아래 &ldquo;한국어 진술문 일괄
              입력&rdquo;에서 별도로 진행해 주세요.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">한국어 유사성 분류 방법 안내문 본문</h2>
            <p className="text-xs text-slate-500">
              카드 수·묶음 규칙처럼 계산되는 값은 직접 숫자를 적지 말고{" "}
              {"{{CARD_COUNT}}"}, {"{{MAX_CARDS_PER_GROUP}}"}, {"{{FIRST_FORBIDDEN_GROUP_SIZE}}"},{" "}
              {"{{MIN_GROUPS}}"}, {"{{MAX_GROUPS}}"}, {"{{MIN_GROUP_BREAKDOWN}}"},{" "}
              {"{{MAX_GROUP_BREAKDOWN}}"} 같은 변수로 입력해 주세요. 실제 진술문 수가 바뀌어도
              코드 배포 없이 안내문이 자동으로 맞춰집니다.
            </p>
            <textarea
              lang="ko"
              rows={10}
              value={koGuideTemplate}
              onChange={(e) => setKoGuideTemplate(e.target.value)}
              placeholder={defaultGuideTemplateFor("ko")}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
            />
            {koGuideUnknownVars.length > 0 && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                알 수 없는 템플릿 변수입니다: {koGuideUnknownVars.map((v) => `{{${v}}}`).join(", ")}
              </p>
            )}
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={generateDefaultKoGuideTemplate}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100"
              >
                현재 카드 수 기준 기본 안내문 생성
              </button>
              <button
                onClick={saveKoGuideTemplate}
                disabled={koGuideSaving || koGuideUnknownVars.length > 0}
                className="rounded-lg bg-slate-900 px-4 py-2 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
              >
                {koGuideSaving ? "저장 중..." : "한국어 안내문 저장"}
              </button>
              {koGuideSavedAt && <span className="text-xs text-green-700">저장됨</span>}
            </div>
            {koGuideRegenConfirm && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 space-y-2">
                <p className="text-sm text-amber-800">
                  현재 저장되지 않은 사용자 지정 안내문이 있습니다. 기본 안내문으로 덮어쓰시겠습니까?
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                  <div>
                    <p className="font-medium mb-1">현재 내용</p>
                    <pre className="whitespace-pre-wrap rounded border border-slate-200 bg-white p-2">{koGuideTemplate}</pre>
                  </div>
                  <div>
                    <p className="font-medium mb-1">기본 안내문</p>
                    <pre className="whitespace-pre-wrap rounded border border-slate-200 bg-white p-2">{defaultGuideTemplateFor("ko")}</pre>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setKoGuideTemplate(defaultGuideTemplateFor("ko"));
                      setKoGuideRegenConfirm(false);
                    }}
                    className="rounded-lg bg-amber-700 px-3 py-1.5 text-white text-xs font-medium hover:bg-amber-800"
                  >
                    기본 안내문으로 덮어쓰기
                  </button>
                  <button
                    onClick={() => setKoGuideRegenConfirm(false)}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-100"
                  >
                    취소
                  </button>
                </div>
              </div>
            )}
            {koGuideSaveError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {koGuideSaveError}
              </p>
            )}
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
              <p className="text-xs font-medium text-slate-500">
                미리보기 (카드 수: {previewCardCount}장 · 최대 {koGuideVars.MAX_CARDS_PER_GROUP}장 ·
                {" "}
                {koGuideVars.FIRST_FORBIDDEN_GROUP_SIZE}장 이상 포함 불가 · 최소{" "}
                {koGuideVars.MIN_GROUPS}개 묶음 · 최대 {koGuideVars.MAX_GROUPS}개 묶음)
              </p>
              {koGuideRender.unknownVariables.length > 0 && (
                <p className="text-xs text-red-600">
                  알 수 없는 변수: {koGuideRender.unknownVariables.map((v) => `{{${v}}}`).join(", ")}
                </p>
              )}
              <div lang="ko" className="text-sm text-slate-700 leading-relaxed space-y-1.5 whitespace-pre-line">
                {koGuideRender.rendered}
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">한국어 진술문 일괄 입력</h2>
            <p className="text-xs text-slate-500">
              한국어 진술문을 순서대로 한 줄에 하나씩 입력해 주세요.
            </p>
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              현재 진술문: {statements.length}개 · 입력된 줄:{" "}
              {splitBulkLines(koBulkText).length}개
            </p>
            {locked && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                이미 제출된 응답이 있습니다. 진술문 개수를 바꾸면 기존 결과와의 일관성이 깨질 수
                있으니, 문구 교정 등 개수가 그대로인 수정만 권장합니다.
              </p>
            )}
            <textarea
              lang="ko"
              rows={14}
              value={koBulkText}
              onChange={(e) => {
                setKoBulkText(e.target.value);
                setKoBulkPreview(null);
                setKoBulkPreviewError(null);
                setKoBulkShowConfirm(false);
              }}
              placeholder={"진술문\n진술문\n진술문\n..."}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
            />

            <button
              onClick={buildKoBulkPreview}
              disabled={!koBulkText.trim()}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
            >
              검증/미리보기
            </button>

            {koBulkPreviewError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {koBulkPreviewError}
              </p>
            )}

            {koBulkPreview && (
              <div className="space-y-3">
                {(() => {
                  const changed = koBulkPreview.filter((p) => p.changed);
                  return (
                    <>
                      <p className="text-sm font-medium">
                        입력된 진술문: {koBulkPreview.length}개 · 변경됨: {changed.length}개
                      </p>
                      {changed.length > 0 && (
                        <div className="max-h-96 overflow-y-auto space-y-2 rounded-lg border border-slate-200 p-2">
                          {changed.map((p) => (
                            <div key={p.order} className="rounded-lg border border-slate-100 p-2 text-sm">
                              <p className="text-xs text-slate-400">#{p.order + 1}</p>
                              {p.before !== null && (
                                <p className="text-slate-400 line-through">이전: {p.before}</p>
                              )}
                              <p>이후: {p.after}</p>
                            </div>
                          ))}
                        </div>
                      )}

                      {koBulkShowConfirm && (
                        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 space-y-2">
                          <p className="text-sm text-red-700">
                            한국어 진술문 {koBulkPreview.length}개 중 {changed.length}개가
                            변경됩니다. 변경하면 기존 미리보기 확인 및 언어 활성화 상태에 영향을
                            줄 수 있습니다. 저장하시겠습니까?
                          </p>
                          <div className="flex gap-2">
                            <button
                              onClick={() => submitKoBulkSave(true)}
                              className="rounded-lg bg-red-700 px-3 py-1.5 text-white text-xs font-medium hover:bg-red-800"
                            >
                              확인, 저장
                            </button>
                            <button
                              onClick={() => setKoBulkShowConfirm(false)}
                              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-100"
                            >
                              취소
                            </button>
                          </div>
                        </div>
                      )}

                      <button
                        onClick={() => submitKoBulkSave(false)}
                        disabled={koBulkSaving || changed.length === 0}
                        className="rounded-lg bg-slate-900 px-4 py-2 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
                      >
                        {koBulkSaving
                          ? "저장 중..."
                          : changed.length === 0
                            ? "변경 사항 없음"
                            : "한국어 진술문 전체 저장"}
                      </button>
                    </>
                  );
                })()}
              </div>
            )}

            {koBulkSaveError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {koBulkSaveError}
              </p>
            )}
            {koBulkSavedCount !== null && (
              <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                {koBulkSavedCount > 0
                  ? `${koBulkSavedCount}개 진술문이 저장되었습니다.`
                  : "변경 사항이 없어 저장하지 않았습니다."}
              </p>
            )}
          </section>

          {statements.length > 0 && !locked && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-slate-600">
                개별 진술문 삭제 (구조 변경 — 진술문 개수를 바꿔야 할 때만 사용)
              </h2>
              <ul className="space-y-1.5">
                {[...statements]
                  .sort((a, b) => a.order - b.order)
                  .map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    >
                      <span>{s.text}</span>
                      <button
                        onClick={() => deleteStatement(s.id)}
                        className="text-slate-400 hover:text-red-500 text-xs"
                      >
                        삭제
                      </button>
                    </li>
                  ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {tab === "ja" && (
        <div className="space-y-10">
          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">日本語 研究資料</h2>
            <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded px-3 py-2 whitespace-pre-line">
              일본 측 책임자·문의처는 아래 문구로만 공개할 수 있습니다 (이메일/전화/주소 등 상세
              연락처 추가 금지):{"\n"}
              {JA_RESPONSIBLE_PARTY_NOTICE}
            </p>
            <div>
              <label className="block text-sm font-medium mb-1">研究タイトル</label>
              <input
                value={jaTitle}
                onChange={(e) => setJaTitle(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                研究の紹介および参加案内
              </label>
              <textarea
                lang="ja"
                rows={8}
                value={jaPrompt}
                onChange={(e) => setJaPrompt(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                研究参加および個人情報の利用に関する同意書
              </label>
              <textarea
                lang="ja"
                rows={10}
                value={jaConsent}
                onChange={(e) => setJaConsent(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
              />
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={saveJaContent}
                disabled={jaSaving}
                className="rounded-lg bg-slate-900 px-4 py-2 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
              >
                {jaSaving ? "저장 중..." : "日本語 자료 저장"}
              </button>
              {jaSavedAt && <span className="text-xs text-green-700">저장됨</span>}
              <a
                href={`/p/${slug}/preview/ja/${adminToken}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm underline text-slate-600"
              >
                日本語画面をプレビュー
              </a>
              <span className="text-xs text-slate-500">
                미리보기 확인: {jaPreview ? new Date(jaPreview).toLocaleString("ko-KR") : "미확인"}
              </span>
            </div>
            {jaSaveError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {jaSaveError}
              </p>
            )}
            <p className="text-xs text-slate-500">
              미리보기 확인은 위 링크로 실제 미리보기 화면을 연 뒤, 그 화면의 확인 버튼을 눌러야
              기록됩니다.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">진술문 카드 수</h2>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={1}
                value={cardCountPreview}
                onChange={(e) => setCardCountPreview(e.target.value)}
                className="w-28 rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <p className="text-xs text-slate-500">
                現在保存されている記述文: <span className="font-medium text-slate-700">{actualCardCount}枚</span>
              </p>
            </div>
            {cardCountMismatch && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                입력한 카드 수({parsedCardCountPreview}개)와 실제 저장된 진술문 수({actualCardCount}개)가
                일치하지 않습니다. 아래 안내문 미리보기는 입력한 카드 수 기준으로 계산되며, 실제
                진술문 개수는 변경되지 않습니다.
              </p>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">日本語 類似性分類方法の案内本文</h2>
            <p className="text-xs text-slate-500">
              計算される値は数字を直接書かず {"{{CARD_COUNT}}"}, {"{{MAX_CARDS_PER_GROUP}}"},{" "}
              {"{{FIRST_FORBIDDEN_GROUP_SIZE}}"}, {"{{MIN_GROUPS}}"}, {"{{MAX_GROUPS}}"},{" "}
              {"{{MIN_GROUP_BREAKDOWN}}"}, {"{{MAX_GROUP_BREAKDOWN}}"} のような変数で入力してください。
            </p>
            <textarea
              lang="ja"
              rows={10}
              value={jaGuideTemplate}
              onChange={(e) => setJaGuideTemplate(e.target.value)}
              placeholder={defaultGuideTemplateFor("ja")}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
            />
            {jaGuideUnknownVars.length > 0 && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                알 수 없는 템플릿 변수입니다: {jaGuideUnknownVars.map((v) => `{{${v}}}`).join(", ")}
              </p>
            )}
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={generateDefaultJaGuideTemplate}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100"
              >
                現在のカード数で基本案内文を生成
              </button>
              <button
                onClick={saveJaGuideTemplate}
                disabled={jaGuideSaving || jaGuideUnknownVars.length > 0}
                className="rounded-lg bg-slate-900 px-4 py-2 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
              >
                {jaGuideSaving ? "저장 중..." : "日本語 안내문 저장"}
              </button>
              {jaGuideSavedAt && <span className="text-xs text-green-700">저장됨</span>}
            </div>
            {jaGuideRegenConfirm && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 space-y-2">
                <p className="text-sm text-amber-800">
                  現在、保存されていないカスタム案内文があります。基本案内文で上書きしますか？
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                  <div>
                    <p className="font-medium mb-1">現在の内容</p>
                    <pre className="whitespace-pre-wrap rounded border border-slate-200 bg-white p-2">{jaGuideTemplate}</pre>
                  </div>
                  <div>
                    <p className="font-medium mb-1">基本案内文</p>
                    <pre className="whitespace-pre-wrap rounded border border-slate-200 bg-white p-2">{defaultGuideTemplateFor("ja")}</pre>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setJaGuideTemplate(defaultGuideTemplateFor("ja"));
                      setJaGuideRegenConfirm(false);
                    }}
                    className="rounded-lg bg-amber-700 px-3 py-1.5 text-white text-xs font-medium hover:bg-amber-800"
                  >
                    基本案内文で上書き
                  </button>
                  <button
                    onClick={() => setJaGuideRegenConfirm(false)}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-100"
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            )}
            {jaGuideSaveError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {jaGuideSaveError}
              </p>
            )}
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
              <p className="text-xs font-medium text-slate-500">
                プレビュー（カード数：{previewCardCount}枚・最大{jaGuideVars.MAX_CARDS_PER_GROUP}枚・
                {jaGuideVars.FIRST_FORBIDDEN_GROUP_SIZE}枚以上不可・最少{jaGuideVars.MIN_GROUPS}グループ・
                最多{jaGuideVars.MAX_GROUPS}グループ）
              </p>
              {jaGuideRender.unknownVariables.length > 0 && (
                <p className="text-xs text-red-600">
                  알 수 없는 변수: {jaGuideRender.unknownVariables.map((v) => `{{${v}}}`).join(", ")}
                </p>
              )}
              <div lang="ja" className="text-sm text-slate-700 leading-relaxed space-y-1.5 whitespace-pre-line">
                {jaGuideRender.rendered}
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">일본어 진술문 일괄 입력</h2>
            <p className="text-xs text-slate-500">
              일본어 진술문을 순서대로 한 줄에 하나씩 입력해 주세요. 번호는 본문에 입력하지
              않아도 됩니다. 이 기능은 번역을 생성하지 않습니다 — 이미 준비된 번역문을 한 번에
              입력하기 위한 도구입니다.
            </p>
            {(() => {
              const orderedStatements = [...statements].sort((a, b) => a.order - b.order);
              const existingJaCount = orderedStatements.filter((s) => s.textJa?.trim()).length;
              const statusCounts = orderedStatements.reduce<Record<string, number>>((acc, s) => {
                acc[s.jaStatus] = (acc[s.jaStatus] ?? 0) + 1;
                return acc;
              }, {});
              return (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 space-y-1">
                  <p>
                    현재 진술문 수: {orderedStatements.length}개 · 일본어 입력됨: {existingJaCount}개
                  </p>
                  <p>
                    상태 분포:{" "}
                    {Object.entries(statusCounts)
                      .map(([k, v]) => `${JA_STATUS_LABELS[k] ?? k} ${v}`)
                      .join(" / ")}
                  </p>
                  {existingJaCount > 0 && (
                    <p className="text-amber-700">
                      기존 일본어 번역이 있습니다. 일괄 저장 시 해당 진술문의 일본어 번역이
                      덮어쓰기됩니다.
                    </p>
                  )}
                </div>
              );
            })()}

            <textarea
              lang="ja"
              rows={10}
              value={jaBulkText}
              onChange={(e) => {
                setJaBulkText(e.target.value);
                setJaBulkPreview(null);
                setJaBulkPreviewError(null);
              }}
              placeholder={`진술문\n진술문\n... (기대: ${statements.length}줄)`}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
            />

            <div className="flex items-center gap-3">
              <label className="text-xs text-slate-600">저장할 상태:</label>
              <select
                value={jaBulkStatus}
                onChange={(e) => setJaBulkStatus(e.target.value as "DRAFT" | "REVIEWING" | "APPROVED")}
                className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
              >
                <option value="DRAFT">초안 (DRAFT)</option>
                <option value="REVIEWING">검토 중 (REVIEWING)</option>
                <option value="APPROVED">승인 (APPROVED)</option>
              </select>
            </div>

            <button
              onClick={buildJaBulkPreview}
              disabled={!jaBulkText.trim()}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
            >
              매핑 미리보기 생성
            </button>

            {jaBulkPreviewError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {jaBulkPreviewError}
              </p>
            )}

            {jaBulkPreview && (
              <div className="space-y-3">
                <p className="text-sm font-medium">
                  입력된 진술문: {jaBulkPreview.length} / {statements.length}
                </p>
                <div className="max-h-96 overflow-y-auto space-y-2 rounded-lg border border-slate-200 p-2">
                  {jaBulkPreview.map((p) => (
                    <div key={p.order} className="rounded-lg border border-slate-100 p-2 text-sm">
                      <p className="text-xs text-slate-400">#{p.order + 1}</p>
                      <p className="text-slate-500">한국어: {p.korean}</p>
                      <p>일본어: {p.japanese}</p>
                    </div>
                  ))}
                </div>

                {statements.some((s) => s.textJa?.trim()) && (
                  <label className="flex items-center gap-2 text-xs text-amber-700">
                    <input
                      type="checkbox"
                      checked={jaBulkAckOverwrite}
                      onChange={(e) => setJaBulkAckOverwrite(e.target.checked)}
                    />
                    기존 일본어 번역이 덮어쓰기되는 것을 확인했습니다.
                  </label>
                )}

                {jaBulkShowApprovedConfirm && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 space-y-2">
                    <p className="text-sm text-red-700">
                      {jaBulkPreview.length}개 일본어 진술문을 모두 APPROVED로 저장하시겠습니까?
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => submitJaBulkSave(true)}
                        className="rounded-lg bg-red-700 px-3 py-1.5 text-white text-xs font-medium hover:bg-red-800"
                      >
                        확인, APPROVED로 저장
                      </button>
                      <button
                        onClick={() => setJaBulkShowApprovedConfirm(false)}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-100"
                      >
                        취소
                      </button>
                    </div>
                  </div>
                )}

                <button
                  onClick={() => submitJaBulkSave(false)}
                  disabled={
                    jaBulkSaving ||
                    (statements.some((s) => s.textJa?.trim()) && !jaBulkAckOverwrite)
                  }
                  className="rounded-lg bg-slate-900 px-4 py-2 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
                >
                  {jaBulkSaving ? "저장 중..." : `${jaBulkPreview.length}개 일괄 저장`}
                </button>
              </div>
            )}

            {jaBulkSaveError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {jaBulkSaveError}
              </p>
            )}
            {jaBulkSavedCount !== null && (
              <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                {jaBulkSavedCount}개 진술문이 저장되었습니다. 아래 개별 편집 목록에도 반영되었습니다.
              </p>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">日本語 記述文 개별 편집 ({statements.length}개)</h2>
            <div className="space-y-2">
              {statements.map((s) => (
                <JaStatementRow
                  key={`${s.id}:${s.textJa ?? ""}:${s.jaStatus}`}
                  statement={s}
                  onSave={saveJaStatement}
                  saving={jaRowSaving === s.id}
                />
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">日本語 CSV Export / Import</h2>
            <button
              onClick={downloadJaExport}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100"
            >
              CSV 내보내기 (statementId, order, textKo, textJa, jaStatus)
            </button>

            <div>
              <label className="block text-sm font-medium mb-1">CSV 불러오기 (텍스트 붙여넣기)</label>
              <textarea
                rows={6}
                value={jaCsvText}
                onChange={(e) => {
                  setJaCsvText(e.target.value);
                  setJaImportPlan(null);
                }}
                placeholder="statementId,order,textKo,textJa,jaStatus"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => runJaImport(false)}
                disabled={jaImportBusy || !jaCsvText.trim()}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
              >
                {jaImportBusy ? "확인 중..." : "미리보기 확인 (dry-run)"}
              </button>
              <button
                onClick={() => runJaImport(true)}
                disabled={jaImportBusy || !jaImportPlan?.ok}
                className="rounded-lg bg-slate-900 px-4 py-2 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
              >
                적용
              </button>
            </div>
            {jaImportError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {jaImportError}
              </p>
            )}
            {jaImportPlan && (
              <div className="space-y-2 text-sm">
                {jaImportPlan.errors.length > 0 && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2">
                    <p className="font-medium text-red-700">오류 ({jaImportPlan.errors.length})</p>
                    <ul className="list-disc pl-5 text-red-700 text-xs">
                      {jaImportPlan.errors.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {jaImportPlan.warnings.length > 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                    <p className="font-medium text-amber-700">경고 ({jaImportPlan.warnings.length})</p>
                    <ul className="list-disc pl-5 text-amber-700 text-xs">
                      {jaImportPlan.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="rounded-lg border border-slate-200 px-3 py-2">
                  <p className="font-medium">
                    변경 예정: {jaImportPlan.changes.filter((c) => c.changed).length}건 / 전체{" "}
                    {jaImportPlan.changes.length}행
                  </p>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {tab === "readiness" && (
        <div className="space-y-8">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">언어별 준비 상태</h2>
            <button
              onClick={loadReadiness}
              disabled={loadingReadiness}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
            >
              {loadingReadiness ? "불러오는 중..." : "새로고침"}
            </button>
          </div>
          {readinessError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {readinessError}
            </p>
          )}
          {activationError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 whitespace-pre-line">
              {activationError}
            </p>
          )}
          {operatingState && (
            <p className="text-xs text-slate-500">현재 운영 상태(계산값): {operatingState}</p>
          )}
          {readiness && (
            <div className="grid gap-6 md:grid-cols-2">
              <ReadinessCard
                label="한국어"
                status={readiness.ko}
                enabled={koEnabled}
                busy={activationBusy}
                onToggle={(next) => setLanguageEnabled("ko", next)}
              />
              <ReadinessCard
                label="日本語"
                status={readiness.ja}
                enabled={jaEnabled}
                busy={activationBusy}
                onToggle={(next) => setLanguageEnabled("ja", next)}
              />
            </div>
          )}
        </div>
      )}

      {tab === "analysis" && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">개념도 분석</h2>
            <button
              onClick={handleDownloadMatrixCsv}
              disabled={loadingMatrix || submissionCount === 0}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
            >
              {loadingMatrix ? "생성 중..." : "집단행렬 CSV 다운로드"}
            </button>
          </div>

          {matrixError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {matrixError}
            </p>
          )}

          <AnalysisPanel slug={slug} adminToken={adminToken} />
        </section>
      )}

      {tab === "participants" && (
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
                disabled={loadingParticipants || submissionCount === 0}
                className="rounded-lg bg-slate-900 px-4 py-2 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
              >
                CSV 다운로드
              </button>
            </div>
          </div>

          {deleteSuccessMessage && (
            <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
              {deleteSuccessMessage}
            </p>
          )}
          {deleteError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {deleteError}
            </p>
          )}
          {participantsError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {participantsError}
            </p>
          )}

          {participants && participants.length > 0 && (
            <>
              <div className="flex items-center justify-between rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedParticipantIds.size === participants.length}
                    onChange={() => toggleSelectAllParticipants(participants)}
                  />
                  전체 선택 ({selectedParticipantIds.size}/{participants.length}명 선택됨)
                </label>
                {selectedParticipantIds.size > 0 && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setSelectedParticipantIds(new Set())}
                      className="text-xs text-slate-500 underline"
                    >
                      선택 해제
                    </button>
                    <button
                      onClick={() =>
                        setDeleteModal({ kind: "selected", sessionIds: [...selectedParticipantIds] })
                      }
                      className="rounded-lg bg-red-600 px-3 py-1.5 text-white text-xs font-medium hover:bg-red-700"
                    >
                      선택 삭제 ({selectedParticipantIds.size}건)
                    </button>
                  </div>
                )}
              </div>

              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full text-sm whitespace-nowrap">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-medium w-8"></th>
                      <th className="text-left px-3 py-2 font-medium">국가</th>
                      <th className="text-left px-3 py-2 font-medium">이름</th>
                      <th className="text-left px-3 py-2 font-medium">성별</th>
                      <th className="text-left px-3 py-2 font-medium">연령</th>
                      <th className="text-left px-3 py-2 font-medium">학교급</th>
                      <th className="text-left px-3 py-2 font-medium">학년</th>
                      <th className="text-left px-3 py-2 font-medium">전화번호</th>
                      <th className="text-left px-3 py-2 font-medium">제출일시</th>
                      <th className="text-left px-3 py-2 font-medium">분류결과</th>
                      <th className="px-3 py-2 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {participants.map((p) => (
                      <tr key={p.id} className="border-t border-slate-100">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={selectedParticipantIds.has(p.id)}
                            onChange={() => toggleParticipantSelected(p.id)}
                          />
                        </td>
                        <td className="px-3 py-2">{countryLabel(p.countryCode)}</td>
                        <td className="px-3 py-2">{p.participantName}</td>
                        <td className="px-3 py-2">{p.gender}</td>
                        <td className="px-3 py-2">{p.age}</td>
                        <td className="px-3 py-2">{p.schoolLevel}</td>
                        <td className="px-3 py-2">{p.grade}</td>
                        <td className="px-3 py-2">{p.phoneNumber}</td>
                        <td className="px-3 py-2">{new Date(p.submittedAt).toLocaleString("ko-KR")}</td>
                        <td className="px-3 py-2 whitespace-normal">{formatGroups(p.groups)}</td>
                        <td className="px-3 py-2">
                          <button
                            onClick={() => setDeleteModal({ kind: "single", sessionIds: [p.id] })}
                            className="text-xs text-red-500 hover:text-red-700 hover:underline"
                          >
                            삭제
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {participants && participants.length === 0 && (
            <p className="text-sm text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
              아직 제출된 참여 기록이 없습니다.
            </p>
          )}

          {participants && participants.length > 0 && (
            <div className="mt-8 rounded-xl border-2 border-red-200 bg-red-50 p-4 space-y-3">
              <h3 className="text-sm font-bold text-red-700">참여 기록 전체 삭제</h3>
              <p className="text-xs text-red-700 whitespace-pre-line">
                프로젝트와 진술문은 유지하고,{"\n"}참여자 정보와 모든 분류 결과만 삭제합니다.
              </p>
              <p className="text-xs text-red-600 whitespace-pre-line">
                삭제한 참여 기록은 복구할 수 없습니다.{"\n"}삭제 전 필요한 경우 참가자 CSV를
                내려받아 별도로 보관해 주세요.
              </p>
              <button
                onClick={() => setDeleteModal({ kind: "all" })}
                className="rounded-lg bg-red-600 px-4 py-2 text-white text-sm font-medium hover:bg-red-700"
              >
                이 프로젝트의 참여 기록 전체 삭제
              </button>
            </div>
          )}

          {deleteModal && (
            <DeleteConfirmModal
              busy={deleteBusy}
              onCancel={() => {
                if (!deleteBusy) setDeleteModal(null);
              }}
              title={
                deleteModal.kind === "all"
                  ? "참여 기록 전체 삭제"
                  : deleteModal.kind === "selected"
                    ? "선택한 참여 기록 삭제"
                    : "참여 기록 삭제"
              }
              message={
                deleteModal.kind === "all"
                  ? "이 프로젝트의 모든 참여 기록을 삭제합니다.\n프로젝트와 진술문은 유지되지만,\n모든 참여자 정보와 분류 결과가 삭제됩니다."
                  : deleteModal.kind === "selected"
                    ? `선택한 참여 기록 ${deleteModal.sessionIds.length}건을 삭제하시겠습니까?\n연결된 묶음과 분류 결과도 함께 삭제되며,\n이 작업은 되돌릴 수 없습니다.`
                    : "선택한 참여 기록을 삭제하시겠습니까?\n연결된 묶음과 분류 결과도 함께 삭제되며,\n이 작업은 되돌릴 수 없습니다."
              }
              confirmLabel="삭제"
              requireTypedConfirmation={
                deleteModal.kind === "all" ? `${slug} 참여 기록 전체 삭제` : undefined
              }
              onConfirm={(typedValue) => {
                if (deleteModal.kind === "all") {
                  performDelete("all", [], typedValue);
                } else {
                  performDelete("selected", deleteModal.sessionIds);
                }
              }}
            />
          )}
        </section>
      )}
    </div>
  );
}

function JaStatementRow({
  statement,
  onSave,
  saving,
}: {
  statement: Statement;
  onSave: (id: string, textJa: string, jaStatus: string) => void;
  saving: boolean;
}) {
  const [textJa, setTextJa] = useState(statement.textJa ?? "");
  const [jaStatus, setJaStatus] = useState(statement.jaStatus);

  return (
    <div className="rounded-lg border border-slate-200 p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs text-slate-400 shrink-0 pt-1.5">#{statement.order + 1}</span>
        <p className="flex-1 text-sm text-slate-500">{statement.text}</p>
      </div>
      <textarea
        lang="ja"
        rows={2}
        value={textJa}
        onChange={(e) => setTextJa(e.target.value)}
        placeholder="日本語訳を入力"
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
      <div className="flex items-center justify-between gap-2">
        <select
          value={jaStatus}
          onChange={(e) => setJaStatus(e.target.value)}
          className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
        >
          {Object.entries(JA_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button
          onClick={() => onSave(statement.id, textJa, jaStatus)}
          disabled={saving}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-white text-xs font-medium hover:bg-slate-700 disabled:opacity-50"
        >
          {saving ? "저장 중..." : "저장"}
        </button>
      </div>
    </div>
  );
}

function ReadinessCard({
  label,
  status,
  enabled,
  busy,
  onToggle,
}: {
  label: string;
  status: LocaleContentStatus;
  enabled: boolean;
  busy: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <div className="rounded-xl border border-slate-200 p-4 space-y-2 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{label}</h3>
        <span
          className={`text-xs rounded-full px-2 py-0.5 ${
            status.ready ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"
          }`}
        >
          {status.ready ? "참여 가능" : "준비 안 됨"}
        </span>
      </div>
      <ul className="space-y-1 text-xs text-slate-600">
        <li>제목: {status.titleComplete ? "✓" : "✗"}</li>
        <li>소개: {status.promptComplete ? "✓" : "✗"}</li>
        <li>
          동의서: {status.consentComplete ? "✓" : "✗"}
          {status.consentUsesLegacyFallback ? " (legacy 폴백 사용 중)" : ""}
        </li>
        {status.locale === "ja" && (
          <>
            <li>동의서 placeholder 검사: {status.consentHasPlaceholder ? "위반" : "통과"}</li>
            <li>동의서 연락처 검사: {status.consentHasDisallowedContact ? "위반" : "통과"}</li>
          </>
        )}
        <li>
          {status.locale === "ko" ? "작성된 진술문" : "작성된 진술문"}: {status.completedStatements}/
          {status.totalStatements}
        </li>
        {status.locale === "ja" && (
          <li>
            승인된 진술문: {status.approvedStatements}/{status.totalStatements}
          </li>
        )}
        {status.missingStatementNumbers.length > 0 && (
          <li>미작성 번호: {status.missingStatementNumbers.join(", ")}</li>
        )}
        {status.locale === "ja" && status.notApprovedStatementNumbers.length > 0 && (
          <li>미승인 번호: {status.notApprovedStatementNumbers.join(", ")}</li>
        )}
        <li>미리보기 확인: {status.previewConfirmed ? "완료" : "미확인"}</li>
      </ul>
      {status.reasons.length > 0 && (
        <ul className="list-disc pl-4 text-xs text-amber-700 space-y-0.5">
          {status.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      <button
        onClick={() => onToggle(!enabled)}
        disabled={busy || (!enabled && !status.ready)}
        className={`w-full rounded-lg px-3 py-2 text-xs font-medium disabled:opacity-50 ${
          enabled
            ? "border border-slate-300 hover:bg-slate-100"
            : "bg-slate-900 text-white hover:bg-slate-700"
        }`}
        title={!enabled && !status.ready ? "준비 조건을 먼저 충족해야 활성화할 수 있습니다." : undefined}
      >
        {enabled ? `${label} 참여 비활성화` : `${label} 참여 활성화`}
      </button>
    </div>
  );
}
