"use client";

import { useMemo, useRef, useState } from "react";
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

const GUIDE_LINK_TEXT = "[유사성 분류 방법 안내문]";

type Statement = { id: string; text: string };
type Group = { id: string; label: string };
type Step = "name" | "consent" | "declined" | "demographics" | "sorting";

const POOL_ID = "pool";

const CONSENT_BODY = `본 연구는 청소년이 인식한 사이버폭력 특징에 대한 개념을 탐색하는 연구입니다. 본 연구의 참여에 앞서 연구에 대한 설명과 동의서를 읽어 보십시오. 귀하의 서명은 연구에 대한 설명을 읽었으며 연구 참여에 동의하였다는 것을 의미합니다.

1. 연구 목적
본 연구의 목적은 청소년이 인식한 사이버폭력 특징의 개념을 체계화하고 분석하며 이를 활용하는 방안을 제안하는 데 있습니다. 도출된 사이버폭력 특징의 구성요소는 향후 한-일 양국 간 인식 비교 연구의 이론적 기초 자료로 활용될 예정입니다.

2. 연구 참여 내용
본 연구진은 사전 인터뷰를 통해 청소년이 인식한 사이버폭력 특징에 대한 개념을 진술문 형태로 추출하였고 이를 유사성 분류 카드(진술문)로 제작하였습니다.

3. 개인정보와 비밀 보장
본 연구진은 귀하의 개인정보 보호를 포함한 연구윤리를 준수할 것입니다. 본 연구의 참여로 수집되는 개인정보는 성명과 성별, 소속, 연령, 연락처 등의 개인식별 정보이며, 이는 연구목적을 위해 코드화하여 처리하고 통계적으로 수치화됩니다. 연구에서 얻어진 개인정보가 학회지나 학회에 활용될 때 귀하의 이름과 개인식별 정보는 사용하지 않습니다.

2026. 08.
이화여자대학교 오인수 교수 연구팀`;

function Card({
  id,
  number,
  text,
}: {
  id: string;
  number: number;
  text: string;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{
        transform: transform
          ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
          : undefined,
        touchAction: "none",
      }}
      className={`select-none cursor-grab active:cursor-grabbing rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      {number}. {text}
    </div>
  );
}

function DropZone({
  id,
  children,
  className,
}: {
  id: string;
  children: React.ReactNode;
  className?: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`${className ?? ""} ${
        isOver ? "ring-2 ring-slate-400 bg-slate-100" : ""
      }`}
    >
      {children}
    </div>
  );
}

export function SortBoard({
  slug,
  title,
  prompt,
  statements,
}: {
  slug: string;
  title: string;
  prompt: string;
  statements: Statement[];
}) {
  const { maxCardsPerGroup, minGroups, maxGroups } = computeGroupBounds(
    statements.length
  );

  const [step, setStep] = useState<Step>("name");
  const [participantName, setParticipantName] = useState("");
  const [consentChoice, setConsentChoice] = useState<
    "agree" | "disagree" | null
  >(null);
  const [gender, setGender] = useState<"남자" | "여자" | "">("");
  const [age, setAge] = useState("");
  const [schoolLevel, setSchoolLevel] = useState<
    "중학교" | "고등학교" | ""
  >("");
  const [grade, setGrade] = useState<"1학년" | "2학년" | "3학년" | "">("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [demographicsError, setDemographicsError] = useState<string | null>(
    null
  );

  const [groups, setGroups] = useState<Group[]>(() =>
    Array.from({ length: minGroups }, (_, i) => ({
      id: `g${i + 1}`,
      label: "",
    }))
  );
  const [assignment, setAssignment] = useState<Record<string, string | null>>(
    () => Object.fromEntries(statements.map((s) => [s.id, null]))
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextGroupNumber = useRef(minGroups + 1);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const statementById = useMemo(
    () => new Map(statements.map((s, i) => [s.id, { ...s, number: i + 1 }])),
    [statements]
  );

  const pooled = statements.filter((s) => assignment[s.id] === null);

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
      const currentSize = statements.filter(
        (s) => assignment[s.id] === containerId
      ).length;
      if (currentSize + 1 > maxCardsPerGroup) {
        window.alert(
          `하나의 묶음에는 전체 진술문의 1/3 이상을 묶을 수 없습니다. 상단의 ${GUIDE_LINK_TEXT}을 다시 한번 숙지해 주세요.`
        );
        return;
      }
    }

    setAssignment((prev) => ({
      ...prev,
      [statementId]: containerId === POOL_ID ? null : containerId,
    }));
  }

  function addGroup() {
    setGroups((prev) => {
      if (prev.length >= maxGroups) return prev;
      const id = `g${nextGroupNumber.current++}`;
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
    setGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, label } : g))
    );
  }

  function handleConsentNext() {
    if (!participantName.trim() || !consentChoice) return;
    setStep(consentChoice === "agree" ? "demographics" : "declined");
  }

  function handleDemographicsSubmit() {
    if (!gender) return setDemographicsError("성별을 선택해 주세요.");
    if (!age.trim() || !Number.isInteger(Number(age)) || Number(age) <= 0) {
      return setDemographicsError("연령을 숫자로 올바르게 입력해 주세요.");
    }
    if (!schoolLevel) return setDemographicsError("학교급을 선택해 주세요.");
    if (!grade) return setDemographicsError("학년을 선택해 주세요.");
    if (!phoneNumber.trim()) {
      return setDemographicsError(
        "답례품 발송을 위한 스마트폰 번호를 입력해 주세요."
      );
    }
    setDemographicsError(null);
    setStep("sorting");
  }

  async function handleSubmit() {
    setError(null);

    if (pooled.length > 0) {
      setError(
        `아직 분류되지 않은 진술문이 ${pooled.length}개 있습니다. 모든 진술문을 하나 이상의 묶음에 배치해 주세요. 상단의 ${GUIDE_LINK_TEXT}을 클릭하여 방법을 다시 확인해 주세요.`
      );
      return;
    }

    const payloadGroups = groups
      .map((g) => ({
        label: g.label,
        statementIds: statements
          .filter((s) => assignment[s.id] === g.id)
          .map((s) => s.id),
      }))
      .filter((g) => g.statementIds.length > 0);

    if (payloadGroups.length === 0) {
      setError(
        `최소 1개 이상의 묶음에 진술문을 배치해 주세요. 상단의 ${GUIDE_LINK_TEXT}을 클릭하여 방법을 다시 확인해 주세요.`
      );
      return;
    }

    if (payloadGroups.length === 1) {
      setError(
        `모든 카드를 하나의 묶음으로 만들 수 없습니다. 상단의 ${GUIDE_LINK_TEXT}을 클릭하여 방법을 다시 확인해 주세요.`
      );
      return;
    }

    const tooSmall = payloadGroups.some((g) => g.statementIds.length < 2);
    if (tooSmall) {
      setError(
        `묶음은 반드시 2장 이상의 카드로 구성되어야 합니다. 상단의 ${GUIDE_LINK_TEXT}을 클릭하여 방법을 다시 확인해 주세요.`
      );
      return;
    }

    const tooBig = payloadGroups.some(
      (g) => g.statementIds.length > maxCardsPerGroup
    );
    if (tooBig) {
      setError(
        `하나의 묶음에는 전체 진술문의 1/3 이상을 묶을 수 없습니다. 상단의 ${GUIDE_LINK_TEXT}을 다시 한번 숙지해 주세요.`
      );
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${slug}/sorts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          participantName,
          consentAgreed: true,
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
        setError(data.error ?? "제출에 실패했습니다.");
        setSubmitting(false);
        return;
      }
      setSubmitted(true);
    } catch {
      setError("네트워크 오류가 발생했습니다.");
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="max-w-xl mx-auto text-center py-24 space-y-3">
        <h1 className="text-2xl font-bold">
          모든 분류가 완료되었습니다. 감사합니다.
        </h1>
      </div>
    );
  }

  if (step === "name") {
    return (
      <div className="max-w-xl mx-auto py-16 space-y-6">
        <div>
          <h1 className="text-2xl font-bold">{title}</h1>
          {prompt && (
            <p className="text-slate-600 mt-2 whitespace-pre-line">
              {prompt}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="name" className="block text-sm font-medium mb-1">
            이름 또는 닉네임
          </label>
          <input
            id="name"
            type="text"
            value={participantName}
            onChange={(e) => setParticipantName(e.target.value)}
            placeholder="예: 참가자1"
            className="w-full rounded-lg border border-slate-300 px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </div>
        <button
          onClick={() => setStep("consent")}
          disabled={!participantName.trim()}
          className="w-full rounded-lg bg-slate-900 px-6 py-3 text-white font-medium hover:bg-slate-700 transition-colors disabled:opacity-50"
        >
          다음
        </button>
      </div>
    );
  }

  if (step === "consent") {
    return (
      <div className="max-w-2xl mx-auto py-16 space-y-6">
        <h1 className="text-xl font-bold">
          [연구 참여 및 정보사용 동의서]
        </h1>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-700 whitespace-pre-line leading-relaxed max-h-[50vh] overflow-y-auto">
          {CONSENT_BODY}
        </div>

        <div>
          <p className="text-sm font-medium mb-2">연구 참여 동의 여부</p>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="consent"
                checked={consentChoice === "agree"}
                onChange={() => setConsentChoice("agree")}
              />
              동의
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="consent"
                checked={consentChoice === "disagree"}
                onChange={() => setConsentChoice("disagree")}
              />
              동의하지 않음
            </label>
          </div>
        </div>

        <div>
          <label
            htmlFor="signatureName"
            className="block text-sm font-medium mb-1"
          >
            연구 참여자 성명
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
          다음
        </button>
      </div>
    );
  }

  if (step === "declined") {
    return (
      <div className="max-w-xl mx-auto text-center py-24 space-y-3">
        <h1 className="text-xl font-bold">
          동의하지 않으신 경우 연구에 참여하실 수 없습니다.
        </h1>
        <p className="text-slate-600">참여를 고려해 주셔서 감사합니다.</p>
      </div>
    );
  }

  if (step === "demographics") {
    return (
      <div className="max-w-xl mx-auto py-16 space-y-6">
        <h1 className="text-xl font-bold">[인적사항]</h1>

        <div>
          <p className="text-sm font-medium mb-2">성별</p>
          <div className="flex gap-4">
            {(["남자", "여자"] as const).map((option) => (
              <label key={option} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="gender"
                  checked={gender === option}
                  onChange={() => setGender(option)}
                />
                {option}
              </label>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="age" className="block text-sm font-medium mb-1">
            연령(숫자만 입력)
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
          <p className="text-sm font-medium mb-2">학교급</p>
          <div className="flex gap-4">
            {(["중학교", "고등학교"] as const).map((option) => (
              <label key={option} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="schoolLevel"
                  checked={schoolLevel === option}
                  onChange={() => setSchoolLevel(option)}
                />
                {option}
              </label>
            ))}
          </div>
        </div>

        <div>
          <p className="text-sm font-medium mb-2">학년</p>
          <div className="flex gap-4">
            {(["1학년", "2학년", "3학년"] as const).map((option) => (
              <label key={option} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="grade"
                  checked={grade === option}
                  onChange={() => setGrade(option)}
                />
                {option}
              </label>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="phone" className="block text-sm font-medium mb-1">
            답례품(기프티콘) 발송을 위한 스마트폰 번호
          </label>
          <input
            id="phone"
            type="tel"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="예: 010-1234-5678"
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
          제출하기
        </button>
      </div>
    );
  }

  const active = activeId ? statementById.get(activeId) : undefined;

  return (
    <div className="max-w-6xl mx-auto py-8 px-4 space-y-6">
      <div>
        <h1 className="text-xl font-bold">{title}</h1>
      </div>

      <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 space-y-1">
        <a
          href={`/p/${slug}/guide`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold underline decoration-2 underline-offset-2 hover:text-blue-700"
        >
          {GUIDE_LINK_TEXT}
        </a>
        <p>
          왼쪽의 진술문을 오른쪽의 묶음으로 드래그해서, 서로 의미가
          비슷하다고 생각되는 진술문끼리 같은 묶음에 넣어 주세요. 묶음은
          최소 {minGroups}개에서 최대 {maxGroups}개까지 만들 수 있으며,
          아래 버튼으로 직접 추가하거나 삭제할 수 있습니다. 모든 진술문을
          하나 이상의 묶음에 배치한 후 제출해 주세요. 자세한 지침은 위
          링크를 클릭해 언제든 다시 확인할 수 있습니다.
        </p>
        {prompt && <p className="whitespace-pre-line">{prompt}</p>}
      </div>

      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="grid md:grid-cols-3 gap-6">
          <DropZone
            id={POOL_ID}
            className="md:col-span-1 rounded-xl border-2 border-dashed border-slate-300 p-4 min-h-[200px] md:max-h-[70vh] md:overflow-y-auto"
          >
            <p className="text-xs font-medium text-slate-500 mb-2">
              진술문 ({pooled.length}개 남음)
            </p>
            <div className="flex flex-col gap-2">
              {pooled.map((s) => (
                <Card
                  key={s.id}
                  id={s.id}
                  number={statementById.get(s.id)!.number}
                  text={s.text}
                />
              ))}
            </div>
          </DropZone>

          <div className="md:col-span-2 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-slate-600">
                묶음 ({groups.length}개 / 최소 {minGroups}개, 최대 {maxGroups}
                개)
              </p>
              <button
                onClick={addGroup}
                disabled={groups.length >= maxGroups}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                + 새 묶음
              </button>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              {groups.map((group, idx) => {
                const items = statements.filter(
                  (s) => assignment[s.id] === group.id
                );
                return (
                  <DropZone
                    key={group.id}
                    id={group.id}
                    className="rounded-xl border border-slate-300 bg-slate-50 p-4 min-h-[140px]"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <input
                        value={group.label}
                        onChange={(e) => updateLabel(group.id, e.target.value)}
                        placeholder={`묶음 ${idx + 1} 이름 (선택)`}
                        className="flex-1 text-sm rounded-md border border-slate-300 px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
                      />
                      {groups.length > minGroups && (
                        <button
                          onClick={() => removeGroup(group.id)}
                          className="text-slate-400 hover:text-red-500 text-xs"
                          aria-label="묶음 삭제"
                        >
                          삭제
                        </button>
                      )}
                    </div>
                    <div className="flex flex-col gap-2">
                      {items.map((s) => (
                        <Card
                          key={s.id}
                          id={s.id}
                          number={statementById.get(s.id)!.number}
                          text={s.text}
                        />
                      ))}
                    </div>
                  </DropZone>
                );
              })}
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

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      <div className="pt-4 border-t border-slate-200">
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="rounded-lg bg-slate-900 px-6 py-3 text-white font-medium hover:bg-slate-700 transition-colors disabled:opacity-50"
        >
          {submitting ? "제출 중..." : "제출하기"}
        </button>
      </div>
    </div>
  );
}
