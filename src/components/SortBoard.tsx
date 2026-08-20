"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { computeGroupBounds } from "@/lib/groupBounds";
import { resolveEffectiveConsentKo } from "@/lib/consent";
import { normalizeFullWidthDigits, isValidJapanesePhoneLast4 } from "@/lib/fullWidthDigits";
import { GENDER_OPTIONS, SCHOOL_LEVEL_OPTIONS, GRADE_OPTIONS } from "@/lib/participantOptions";
import { getParticipantMessages, type MessageShape, type ParticipantLocale } from "@/messages/participant";
import { applyStudyWebAppTextOverride } from "@/lib/studyWebAppText";
import type { ErrorCode } from "@/lib/errorCodes";
import {
  COUNTRY_OPTIONS,
  countryToLocale,
  initialCountry,
  initialParticipantStep,
  isCountryAvailable,
  restoredCountryFromStorage,
  type CountryCode,
} from "@/lib/participantCountryFlow";

type StatementInput = {
  id: string;
  order: number;
  text: string;
  textJa: string | null;
  jaStatus: string;
};
type Group = { id: string; label: string };
type Step = "country" | "name" | "consent" | "declined" | "demographics" | "sorting" | "submitted";

const POOL_ID = "pool";

// Shared verbatim so Tailwind's static scanner sees every class it needs to
// generate. Applied to both the statement panel and every group column so
// their outer widths always match exactly, on every screen size (no 2xl
// widening for groups).
const FIXED_PANEL_WIDTH =
  "md:w-[280px] md:min-w-[280px] md:max-w-[280px] md:shrink-0";

/** Resolves a submit-API errorCode to localized text; never falls back to the server's Korean string when locale is ja. */
function localizedError(
  t: MessageShape,
  errorCode: string | undefined,
  locale: ParticipantLocale,
  koFallback: string,
  n?: number
): string {
  const entry = errorCode && errorCode in t.errors ? t.errors[errorCode as ErrorCode] : undefined;
  if (typeof entry === "function") return entry(n ?? 0);
  if (typeof entry === "string") return entry;
  return locale === "ko" ? koFallback : t.errors.SUBMISSION_FAILED as string;
}

function Card({ id, number, text }: { id: string; number: number; text: string }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        touchAction: "none",
      }}
      className={`flex min-w-0 select-none items-start gap-2 rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-[13px] leading-5 shadow-xs cursor-grab active:cursor-grabbing ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <span className="mt-0.5 inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-semibold text-slate-600">
        {number}
      </span>
      <span className="min-w-0 flex-1 break-words leading-5">{text}</span>
    </div>
  );
}

function DropZone({
  id,
  children,
  className,
  innerRef,
}: {
  id: string;
  children: React.ReactNode;
  className?: string;
  innerRef?: (node: HTMLDivElement | null) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={(node) => {
        setNodeRef(node);
        innerRef?.(node);
      }}
      className={`${className ?? ""} ${isOver ? "ring-2 ring-blue-400 bg-blue-50" : ""}`}
    >
      {children}
    </div>
  );
}

function BookIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4 shrink-0" aria-hidden="true">
      <path d="M3.5 4.5c1.5-1 3.5-1 5 0v11c-1.5-1-3.5-1-5 0v-11ZM16.5 4.5c-1.5-1-3.5-1-5 0v11c1.5-1 3.5-1 5 0v-11Z" strokeLinejoin="round" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 shrink-0" aria-hidden="true">
      <path d="M6.5 4.5a1 1 0 0 1 1.53-.848l7 4.5a1 1 0 0 1 0 1.696l-7 4.5A1 1 0 0 1 6.5 13.5v-9Z" />
    </svg>
  );
}

function VideoGuideLink({
  href,
  label,
  lang,
}: {
  href: string;
  label: string;
  lang?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      lang={lang}
      className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-900 underline decoration-2 underline-offset-2 hover:bg-blue-100"
    >
      <PlayIcon />
      {label}
    </a>
  );
}

function CountryStep({
  initialSelected,
  error,
  videoUrlKo,
  videoUrlJa,
  onSelect,
}: {
  initialSelected: CountryCode | null;
  error: string | null;
  videoUrlKo: string | null;
  videoUrlJa: string | null;
  onSelect: (country: CountryCode) => void;
}) {
  // `initialSelected` (from a prior visit's sessionStorage) only highlights a
  // default choice — it never auto-advances past this screen. The
  // participant must still explicitly press the confirm button below.
  //
  // `initialSelected` arrives asynchronously (the parent restores it from
  // sessionStorage inside a post-mount effect), so this can't just be a
  // useState initializer — that only reads the prop on the very first
  // render and would silently miss the later update. Sync on every change,
  // but stop once the participant has clicked a button themselves so a
  // slow-arriving restore can never clobber their explicit choice.
  const [selected, setSelected] = useState<CountryCode | null>(initialSelected);
  const userPickedRef = useRef(false);

  useEffect(() => {
    if (!userPickedRef.current) setSelected(initialSelected);
  }, [initialSelected]);

  function pick(code: CountryCode) {
    userPickedRef.current = true;
    setSelected(code);
  }

  return (
    <div className="max-w-xl mx-auto py-16 px-1 space-y-6">
      <div className="space-y-1 text-center">
        <h1 className="text-xl font-bold">참여 국가를 선택해 주세요</h1>
        <h1 lang="ja" className="text-xl font-bold">参加する国を選択してください</h1>
        <p className="text-sm text-slate-500">Please select your country.</p>
      </div>

      {(videoUrlKo || videoUrlJa) && (
        <div className="flex flex-col items-center gap-2">
          {videoUrlKo && (
            <VideoGuideLink href={videoUrlKo} label="[유사성 분류 웹앱 사용 방법 - 가이드라인 동영상]" />
          )}
          {videoUrlJa && (
            <VideoGuideLink
              href={videoUrlJa}
              label="［類似性分類ウェブアプリの使い方－ガイドライン動画］"
              lang="ja"
            />
          )}
        </div>
      )}

      <div
        role="radiogroup"
        aria-label="참여 국가 선택 / 参加する国の選択"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        {COUNTRY_OPTIONS.map((opt) => {
          const isSelected = selected === opt.code;
          return (
            <button
              key={opt.code}
              type="button"
              role="radio"
              aria-checked={isSelected}
              lang={opt.code === "JP" ? "ja" : undefined}
              onClick={() => pick(opt.code)}
              className={`rounded-xl border-2 px-5 py-8 text-center text-lg font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 ${
                isSelected
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {error && <p className="text-sm text-red-600 whitespace-pre-line text-center">{error}</p>}

      <button
        onClick={() => selected && onSelect(selected)}
        disabled={!selected}
        className="w-full rounded-lg bg-slate-900 px-6 py-3 text-white font-medium hover:bg-slate-700 transition-colors disabled:opacity-50"
      >
        다음 / 次へ
      </button>
    </div>
  );
}

export function SortBoard({
  slug,
  title,
  prompt,
  consentKo,
  legacyConsentFallbackEnabled,
  titleJa,
  promptJa,
  consentJa,
  koreanAvailable,
  japaneseAvailable,
  guideVideoUrlKo,
  guideVideoUrlJa,
  statements,
  previewMode = false,
  previewLocale,
}: {
  slug: string;
  title: string;
  prompt: string;
  consentKo: string | null;
  legacyConsentFallbackEnabled: boolean;
  titleJa: string | null;
  promptJa: string | null;
  consentJa: string | null;
  koreanAvailable: boolean;
  japaneseAvailable: boolean;
  guideVideoUrlKo: string | null;
  guideVideoUrlJa: string | null;
  statements: StatementInput[];
  previewMode?: boolean;
  previewLocale?: ParticipantLocale;
}) {
  const { maxCardsPerGroup, minGroups, maxGroups } = computeGroupBounds(statements.length);
  const storageKey = `concept-sort:${slug}:country`;

  // Country selection is always the first screen of the live participant
  // flow, regardless of how many languages are currently available — a
  // participant must explicitly see and confirm their country every visit.
  // Only the authenticated researcher preview (previewMode + previewLocale)
  // is allowed to bypass this screen and jump straight into a specific
  // locale.
  const [country, setCountryState] = useState<CountryCode | null>(() =>
    initialCountry(previewMode, previewLocale)
  );
  const [step, setStep] = useState<Step>(() => initialParticipantStep(previewMode));
  const [countryError, setCountryError] = useState<string | null>(null);

  // Restore a previously chosen country from sessionStorage after mount
  // (client-only, so it can never cause an SSR/hydration mismatch) — this
  // only preselects the highlighted button on the country screen; it must
  // never skip or auto-advance past the country screen itself.
  useEffect(() => {
    if (previewMode) return;
    const timer = setTimeout(() => {
      try {
        const stored = sessionStorage.getItem(storageKey);
        const restored = restoredCountryFromStorage(stored, koreanAvailable, japaneseAvailable);
        if (restored) setCountryState(restored);
      } catch {
        // sessionStorage unavailable (privacy mode etc.) — just start unselected.
      }
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const locale: ParticipantLocale = country ? countryToLocale(country) : "ko";
  const t = applyStudyWebAppTextOverride(getParticipantMessages(locale), slug, locale);
  const localeVideoUrl = locale === "ja" ? guideVideoUrlJa : guideVideoUrlKo;

  // Reflects the active locale on <html lang> while this board is mounted,
  // restoring whatever it was before on unmount so other pages aren't affected.
  useEffect(() => {
    if (!country) return;
    const prev = document.documentElement.lang;
    document.documentElement.lang = locale;
    return () => {
      document.documentElement.lang = prev;
    };
  }, [country, locale]);

  function chooseCountry(next: CountryCode) {
    if (!isCountryAvailable(next, koreanAvailable, japaneseAvailable)) {
      // Bilingual, since the locale isn't established yet at this step.
      setCountryError(
        `${getParticipantMessages("ko").errors.COUNTRY_NOT_AVAILABLE}\n${
          getParticipantMessages("ja").errors.COUNTRY_NOT_AVAILABLE
        }`
      );
      return;
    }
    setCountryError(null);
    setCountryState(next);
    if (!previewMode) {
      try {
        sessionStorage.setItem(storageKey, next);
      } catch {
        // ignore — non-fatal, just means the choice won't survive a refresh
      }
    }
    setStep("name");
  }

  const displayTitle = locale === "ko" ? title : titleJa ?? "";
  const displayPrompt = locale === "ko" ? prompt : promptJa ?? "";
  const displayConsent =
    locale === "ko"
      ? resolveEffectiveConsentKo({ consentKo, legacyConsentFallbackEnabled })
      : consentJa;

  const localizedStatements = statements.map((s) => ({
    id: s.id,
    text: locale === "ko" ? s.text : s.textJa ?? "",
  }));

  const [participantName, setParticipantName] = useState("");
  const [consentChoice, setConsentChoice] = useState<"agree" | "disagree" | null>(null);
  const [gender, setGender] = useState("");
  const [age, setAge] = useState("");
  const [schoolLevel, setSchoolLevel] = useState("");
  const [grade, setGrade] = useState("");
  // The only back-navigation in the whole flow is the "name" step's button,
  // which returns to "country" — reachable before demographics (and so
  // before phoneNumber) is ever touched. Consent and demographics have no
  // back button, so a participant can never carry a phoneNumber value typed
  // for one country into a re-render for the other; nothing to reset here.
  const [phoneNumber, setPhoneNumber] = useState("");
  const [demographicsError, setDemographicsError] = useState<string | null>(null);

  const [groups, setGroups] = useState<Group[]>(() =>
    Array.from({ length: minGroups }, (_, i) => ({ id: `g${i + 1}`, label: "" }))
  );
  const [assignment, setAssignment] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(statements.map((s) => [s.id, null]))
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [highlightedGroupId, setHighlightedGroupId] = useState<string | null>(null);
  const labelInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const groupWrapperRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const poolPanelRef = useRef<HTMLDivElement | null>(null);
  const groupBoardRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusIdRef = useRef<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const statementById = useMemo(
    () => new Map(localizedStatements.map((s, i) => [s.id, { ...s, number: i + 1 }])),
    [localizedStatements]
  );

  const pooled = localizedStatements.filter((s) => assignment[s.id] === null);

  // Scrolls a group into view. On the desktop horizontal board, this moves
  // only the board's own scrollLeft (never the page or the left panel); on
  // mobile, where the board is a normal vertical stack (scrollWidth ===
  // clientWidth, no horizontal overflow), it falls back to a plain
  // scrollIntoView. `board` needs `position: relative` for `offsetLeft` to
  // be measured relative to it rather than some other ancestor.
  //
  // `behavior: "smooth"` is driven by the compositor and, like
  // requestAnimationFrame, silently never completes while the tab is
  // backgrounded (document.visibilityState === "hidden") in most browsers
  // — so that case scrolls instantly instead.
  function scrollGroupIntoView(id: string) {
    const board = groupBoardRef.current;
    const group = groupWrapperRefs.current.get(id);
    if (!group) return;

    const behavior: ScrollBehavior =
      typeof document !== "undefined" && document.visibilityState === "hidden" ? "instant" : "smooth";

    if (board && board.scrollWidth > board.clientWidth) {
      const targetLeft = group.offsetLeft - board.clientWidth + group.offsetWidth + 16;
      board.scrollTo({ left: Math.max(0, targetLeft), behavior });
    } else {
      group.scrollIntoView({ behavior, block: "nearest" });
    }
  }

  // Runs after a newly added group has mounted and settled into the board
  // layout: scroll it into view, then focus its label input without
  // scrolling again. Two rAFs ensure the flex layout (and thus the group's
  // final position) has been computed before we scroll. Only touches
  // refs/the DOM, no setState here.
  //
  // requestAnimationFrame never fires while the tab is backgrounded
  // (document.visibilityState === "hidden") in most browsers, which would
  // silently strand the scroll/focus indefinitely — so that case runs
  // immediately instead of waiting on rAF.
  useEffect(() => {
    const id = pendingFocusIdRef.current;
    if (!id) return;
    pendingFocusIdRef.current = null;

    const runFocus = () => {
      scrollGroupIntoView(id);
      labelInputRefs.current.get(id)?.focus({ preventScroll: true });
    };

    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      runFocus();
      return;
    }

    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(runFocus);
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [groups]);

  // Clears the highlight flash a moment after it's set.
  useEffect(() => {
    if (!highlightedGroupId) return;
    const timer = setTimeout(() => setHighlightedGroupId(null), 900);
    return () => clearTimeout(timer);
  }, [highlightedGroupId]);

  function flashGroup(groupId: string) {
    scrollGroupIntoView(groupId);
    setHighlightedGroupId(groupId);
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;
    const statementId = String(active.id);
    const containerId = String(over.id);

    if (containerId !== POOL_ID && assignment[statementId] !== containerId) {
      const currentSize = localizedStatements.filter((s) => assignment[s.id] === containerId).length;
      if (currentSize + 1 > maxCardsPerGroup) {
        window.alert((t.errors.GROUP_TOO_LARGE as (n: number) => string)(maxCardsPerGroup));
        return;
      }
    }

    setAssignment((prev) => ({
      ...prev,
      [statementId]: containerId === POOL_ID ? null : containerId,
    }));
  }

  function addGroup() {
    // Precomputed outside the updater (not a counter mutated inside it) so
    // the updater stays pure: React (Strict Mode in dev, and potentially
    // other internals) may invoke it more than once for the same prev
    // state, and every invocation must produce the same result.
    const id = crypto.randomUUID();
    setGroups((prev) => {
      if (prev.length >= maxGroups) return prev;
      pendingFocusIdRef.current = id;
      setHighlightedGroupId(id);
      return [...prev, { id, label: "" }];
    });
  }

  function removeGroup(groupId: string) {
    let removed = false;
    setGroups((prev) => {
      if (prev.length <= minGroups) return prev;
      removed = true;
      return prev.filter((g) => g.id !== groupId);
    });
    if (!removed) return;
    setAssignment((prev) => {
      const next = { ...prev };
      for (const [statementId, gid] of Object.entries(next)) {
        if (gid === groupId) next[statementId] = null;
      }
      return next;
    });
  }

  function updateLabel(groupId: string, label: string) {
    setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, label } : g)));
  }

  function handleConsentNext() {
    if (!participantName.trim() || !consentChoice) return;
    setStep(consentChoice === "agree" ? "demographics" : "declined");
  }

  function handleDemographicsSubmit() {
    if (!gender) return setDemographicsError(t.errors.GENDER_REQUIRED as string);
    if (!age.trim() || !Number.isInteger(Number(age)) || Number(age) <= 0) {
      return setDemographicsError(t.errors.AGE_INVALID as string);
    }
    if (!schoolLevel) return setDemographicsError(t.errors.SCHOOL_LEVEL_REQUIRED as string);
    if (!grade) return setDemographicsError(t.errors.GRADE_REQUIRED as string);
    // Japan collects only the last 4 digits of the mobile phone number, for
    // participant identification — never the full number, from the input
    // step onward (not collected-then-truncated). Korea keeps the original
    // full-number field and validation unchanged.
    if (country === "JP") {
      if (!isValidJapanesePhoneLast4(phoneNumber)) {
        return setDemographicsError(t.errors.PHONE_INVALID as string);
      }
    } else if (!phoneNumber.trim()) {
      return setDemographicsError(t.errors.PHONE_REQUIRED as string);
    }
    setDemographicsError(null);
    setStep("sorting");
  }

  async function handleSubmit() {
    setError(null);

    if (pooled.length > 0) {
      poolPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      setError((t.errors.UNASSIGNED_STATEMENTS as (n: number) => string)(pooled.length));
      return;
    }

    const payloadGroupsWithId = groups
      .map((g) => ({
        id: g.id,
        label: g.label,
        statementIds: localizedStatements.filter((s) => assignment[s.id] === g.id).map((s) => s.id),
      }))
      .filter((g) => g.statementIds.length > 0);

    if (payloadGroupsWithId.length === 0) {
      setError((t.errors.UNASSIGNED_STATEMENTS as (n: number) => string)(localizedStatements.length));
      return;
    }

    if (payloadGroupsWithId.length === 1) {
      flashGroup(payloadGroupsWithId[0].id);
      setError(t.errors.ONE_GROUP_ONLY as string);
      return;
    }

    const offendingSmall = payloadGroupsWithId.find((g) => g.statementIds.length < 2);
    if (offendingSmall) {
      flashGroup(offendingSmall.id);
      setError(t.errors.GROUP_TOO_SMALL as string);
      return;
    }

    const offendingBig = payloadGroupsWithId.find((g) => g.statementIds.length > maxCardsPerGroup);
    if (offendingBig) {
      flashGroup(offendingBig.id);
      setError((t.errors.GROUP_TOO_LARGE as (n: number) => string)(maxCardsPerGroup));
      return;
    }

    if (previewMode) return; // submit button stays disabled; this is unreachable in the UI

    const payloadGroups = payloadGroupsWithId.map(({ label, statementIds }) => ({ label, statementIds }));

    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${slug}/sorts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          participantName,
          consentAgreed: true,
          countryCode: country,
          gender,
          age: Number(age),
          schoolLevel,
          grade,
          phoneNumber,
          groups: payloadGroups,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(localizedError(t, data.errorCode, locale, data.error));
        setSubmitting(false);
        return;
      }
      setSubmitted(true);
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        // non-fatal
      }
    } catch {
      setError(t.errors.NETWORK_ERROR as string);
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div lang={locale} className="max-w-xl mx-auto text-center py-24 space-y-3">
        <h1 className="text-2xl font-bold">{t.submitted.heading}</h1>
      </div>
    );
  }

  if (step === "country") {
    return (
      <CountryStep
        initialSelected={country}
        error={countryError}
        videoUrlKo={guideVideoUrlKo}
        videoUrlJa={guideVideoUrlJa}
        onSelect={chooseCountry}
      />
    );
  }

  if (step === "name") {
    return (
      <div lang={locale} className="max-w-xl mx-auto py-16 space-y-6">
        <div>
          <h1 className="text-2xl font-bold">{displayTitle}</h1>
          {displayPrompt && (
            <p className="text-slate-600 mt-2 whitespace-pre-line">{displayPrompt}</p>
          )}
        </div>
        <div>
          <label htmlFor="name" className="block text-sm font-medium mb-1">
            {t.nameStep.label}
          </label>
          <input
            id="name"
            type="text"
            value={participantName}
            onChange={(e) => setParticipantName(e.target.value)}
            placeholder={t.nameStep.placeholder}
            className="w-full rounded-lg border border-slate-300 px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </div>
        <div className="flex gap-3">
          {!previewMode && (
            <button
              onClick={() => setStep("country")}
              className="rounded-lg border border-slate-300 px-6 py-3 font-medium hover:bg-slate-100 transition-colors"
            >
              {t.common.back}
            </button>
          )}
          <button
            onClick={() => setStep("consent")}
            disabled={!participantName.trim()}
            className="flex-1 rounded-lg bg-slate-900 px-6 py-3 text-white font-medium hover:bg-slate-700 transition-colors disabled:opacity-50"
          >
            {t.common.next}
          </button>
        </div>
      </div>
    );
  }

  if (step === "consent") {
    return (
      <div lang={locale} className="max-w-2xl mx-auto py-16 space-y-6">
        <h1 className="text-xl font-bold">{t.consentStep.heading}</h1>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-700 whitespace-pre-line leading-relaxed max-h-[50vh] overflow-y-auto">
          {displayConsent}
        </div>

        <div>
          <p className="text-sm font-medium mb-2">{t.consentStep.questionLabel}</p>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="consent"
                checked={consentChoice === "agree"}
                onChange={() => setConsentChoice("agree")}
              />
              {t.consentStep.agree}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="consent"
                checked={consentChoice === "disagree"}
                onChange={() => setConsentChoice("disagree")}
              />
              {t.consentStep.disagree}
            </label>
          </div>
        </div>

        <div>
          <label htmlFor="signatureName" className="block text-sm font-medium mb-1">
            {t.consentStep.signatureLabel}
          </label>
          <input
            id="signatureName"
            type="text"
            value={participantName}
            onChange={(e) => setParticipantName(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </div>

        <button
          onClick={handleConsentNext}
          disabled={!participantName.trim() || !consentChoice}
          className="w-full rounded-lg bg-slate-900 px-6 py-3 text-white font-medium hover:bg-slate-700 transition-colors disabled:opacity-50"
        >
          {t.common.next}
        </button>
      </div>
    );
  }

  if (step === "declined") {
    return (
      <div lang={locale} className="max-w-xl mx-auto text-center py-24 space-y-3">
        <h1 className="text-xl font-bold">{t.declinedStep.heading}</h1>
        <p className="text-slate-600">{t.declinedStep.body}</p>
      </div>
    );
  }

  if (step === "demographics") {
    return (
      <div lang={locale} className="max-w-xl mx-auto py-16 space-y-6">
        <h1 className="text-xl font-bold">{t.demographics.heading}</h1>

        <div>
          <p className="text-sm font-medium mb-2">{t.demographics.genderLabel}</p>
          <div className="flex gap-4">
            {GENDER_OPTIONS.map((option) => (
              <label key={option.value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="gender"
                  checked={gender === option.value}
                  onChange={() => setGender(option.value)}
                />
                {option[locale]}
              </label>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="age" className="block text-sm font-medium mb-1">
            {t.demographics.ageLabel}
          </label>
          <input
            id="age"
            type="number"
            inputMode="numeric"
            value={age}
            onChange={(e) => setAge(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </div>

        <div>
          <p className="text-sm font-medium mb-2">{t.demographics.schoolLevelLabel}</p>
          <div className="flex gap-4">
            {SCHOOL_LEVEL_OPTIONS.map((option) => (
              <label key={option.value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="schoolLevel"
                  checked={schoolLevel === option.value}
                  onChange={() => setSchoolLevel(option.value)}
                />
                {option[locale]}
              </label>
            ))}
          </div>
        </div>

        <div>
          <p className="text-sm font-medium mb-2">{t.demographics.gradeLabel}</p>
          <div className="flex gap-4">
            {GRADE_OPTIONS.map((option) => (
              <label key={option.value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="grade"
                  checked={grade === option.value}
                  onChange={() => setGrade(option.value)}
                />
                {option[locale]}
              </label>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="phone" className="block text-sm font-medium mb-1">
            {t.demographics.phoneLabel}
          </label>
          {t.demographics.phoneHelperText && (
            <p className="text-xs text-slate-500 mb-1">{t.demographics.phoneHelperText}</p>
          )}
          <input
            id="phone"
            type="tel"
            inputMode={country === "JP" ? "numeric" : undefined}
            maxLength={country === "JP" ? 4 : undefined}
            value={phoneNumber}
            onChange={(e) => {
              // Japan: minimize collection at the input step itself — digits
              // only (full-width IME input auto-normalized, leading zero
              // preserved as a string throughout), capped at 4 characters.
              // The full number is never held in state even transiently.
              // Korea: unchanged raw passthrough.
              const next =
                country === "JP"
                  ? normalizeFullWidthDigits(e.target.value).replace(/[^0-9]/g, "").slice(0, 4)
                  : e.target.value;
              setPhoneNumber(next);
            }}
            placeholder={t.demographics.phonePlaceholder}
            className="w-full rounded-lg border border-slate-300 px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </div>

        {demographicsError && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {demographicsError}
          </p>
        )}

        <button
          onClick={handleDemographicsSubmit}
          className="w-full rounded-lg bg-slate-900 px-6 py-3 text-white font-medium hover:bg-slate-700 transition-colors"
        >
          {t.demographics.submitLabel}
        </button>
      </div>
    );
  }

  const active = activeId ? statementById.get(activeId) : undefined;

  return (
    <div lang={locale} className="mx-auto flex w-full max-w-none flex-col px-3 py-3 md:h-dvh md:overflow-hidden">
      <div className="shrink-0">
        <h1 className="text-xl font-bold">{displayTitle}</h1>
      </div>

      <div className="mt-3 shrink-0 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`/p/${slug}/guide?lang=${locale}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-semibold underline decoration-2 underline-offset-2 hover:text-blue-700"
          >
            <BookIcon />
            {t.guide.linkText}
          </a>
          {localeVideoUrl && <VideoGuideLink href={localeVideoUrl} label={t.videoGuide.linkText} />}
        </div>
        <p className="text-xs text-blue-700">{t.guide.linkDescription}</p>
        <p>{t.guide.instructions(minGroups, maxGroups)}</p>
      </div>

      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        autoScroll={{ enabled: true }}
      >
        <div className="mt-3 flex flex-col gap-4 md:mt-4 md:min-h-0 md:flex-1 md:flex-row md:gap-4 md:overflow-hidden">
          <DropZone
            id={POOL_ID}
            innerRef={(node) => {
              poolPanelRef.current = node;
            }}
            className={`flex flex-col rounded-xl border-2 border-dashed border-slate-300 md:min-h-0 md:overflow-hidden ${FIXED_PANEL_WIDTH}`}
          >
            <p className="shrink-0 px-4 pt-3 pb-2 text-xs font-medium text-slate-500">
              {t.sorting.unassignedLabel(pooled.length)}
            </p>
            <div className="flex flex-col gap-2 px-4 pb-4 md:min-h-0 md:flex-1 md:overflow-y-auto md:overscroll-contain">
              {pooled.map((s) => (
                <Card key={s.id} id={s.id} number={statementById.get(s.id)!.number} text={s.text} />
              ))}
            </div>
          </DropZone>

          <div className="flex min-w-0 flex-col md:min-h-0 md:flex-1">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 pb-2">
              <p className="text-sm font-medium text-slate-600">
                {t.sorting.groupsLabel(groups.length, minGroups, maxGroups)}
              </p>
              <p className="hidden text-xs text-slate-400 md:inline">{t.sorting.scrollHint}</p>
            </div>

            <div
              ref={groupBoardRef}
              className="relative flex flex-col gap-3 md:min-h-0 md:flex-1 md:flex-row md:flex-nowrap md:items-stretch md:gap-3 md:overflow-x-auto md:overflow-y-hidden md:overscroll-x-contain md:pb-2 md:pr-2 [scrollbar-gutter:stable] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-300"
            >
              {groups.map((group, idx) => {
                const items = localizedStatements.filter((s) => assignment[s.id] === group.id);
                const isHighlighted = highlightedGroupId === group.id;
                return (
                  <DropZone
                    key={group.id}
                    id={group.id}
                    innerRef={(node) => {
                      if (node) groupWrapperRefs.current.set(group.id, node);
                      else groupWrapperRefs.current.delete(group.id);
                    }}
                    className={`flex min-w-0 flex-col overflow-hidden rounded-xl border bg-slate-50 transition-colors duration-700 md:h-full md:self-stretch ${FIXED_PANEL_WIDTH} ${
                      isHighlighted ? "border-emerald-400 bg-emerald-50" : "border-slate-300"
                    }`}
                  >
                    <div className="flex shrink-0 items-center gap-1.5 px-3 pt-3 pb-2">
                      <input
                        ref={(el) => {
                          if (el) labelInputRefs.current.set(group.id, el);
                          else labelInputRefs.current.delete(group.id);
                        }}
                        value={group.label}
                        onChange={(e) => updateLabel(group.id, e.target.value)}
                        placeholder={t.sorting.groupNamePlaceholder(idx + 1)}
                        className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-slate-400"
                      />
                      <span className="shrink-0 whitespace-nowrap text-[11px] text-slate-500">
                        {idx + 1} · {t.sorting.cardCount(items.length)}
                      </span>
                      {groups.length > minGroups && (
                        <button
                          onClick={() => removeGroup(group.id)}
                          className="shrink-0 px-1 py-0.5 text-xs text-slate-400 hover:text-red-500"
                          aria-label={t.sorting.deleteGroup}
                        >
                          {t.sorting.deleteGroup}
                        </button>
                      )}
                    </div>
                    <div className="flex min-h-[64px] min-w-0 flex-col gap-1.5 px-2.5 pb-3 md:min-h-0 md:flex-1 md:overflow-y-auto md:overscroll-y-contain md:pr-2 md:[scrollbar-gutter:stable] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-300">
                      {items.map((s) => (
                        <Card key={s.id} id={s.id} number={statementById.get(s.id)!.number} text={s.text} />
                      ))}
                    </div>
                  </DropZone>
                );
              })}

              <button
                onClick={addGroup}
                disabled={groups.length >= maxGroups}
                className="flex h-11 w-full shrink-0 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed md:w-[180px] md:self-start"
              >
                {t.sorting.addGroup}
              </button>
            </div>
          </div>
        </div>

        <DragOverlay>
          {active ? (
            <div className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-lg">
              {active.number}. {active.text}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <div className="mt-3 shrink-0 border-t border-slate-200 pt-3">
        {pooled.length > 0 && (
          <p className="mb-2 text-xs text-amber-700">{t.sorting.unassignedLabel(pooled.length)}</p>
        )}
        {error && (
          <p className="mb-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </p>
        )}
        <button
          onClick={handleSubmit}
          disabled={submitting || previewMode}
          title={previewMode ? "미리보기 모드에서는 제출할 수 없습니다." : undefined}
          className="rounded-lg bg-slate-900 px-6 py-3 text-white font-medium hover:bg-slate-700 transition-colors disabled:opacity-50"
        >
          {submitting ? t.common.submitting : t.common.submit}
        </button>
      </div>
    </div>
  );
}
