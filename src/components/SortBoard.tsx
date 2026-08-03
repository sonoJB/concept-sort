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

type Statement = { id: string; text: string };
type Group = { id: string; label: string };

const POOL_ID = "pool";

function Card({ id, text }: { id: string; text: string }) {
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
      {text}
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
  const [participantName, setParticipantName] = useState("");
  const [started, setStarted] = useState(false);
  const [groups, setGroups] = useState<Group[]>([{ id: "g1", label: "" }]);
  const [assignment, setAssignment] = useState<Record<string, string | null>>(
    () => Object.fromEntries(statements.map((s) => [s.id, null]))
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextGroupNumber = useRef(2);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const statementById = useMemo(
    () => new Map(statements.map((s) => [s.id, s])),
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
    setAssignment((prev) => ({
      ...prev,
      [statementId]: containerId === POOL_ID ? null : containerId,
    }));
  }

  function addGroup() {
    const id = `g${nextGroupNumber.current++}`;
    setGroups((prev) => [...prev, { id, label: "" }]);
  }

  function removeGroup(groupId: string) {
    setGroups((prev) => prev.filter((g) => g.id !== groupId));
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

  async function handleSubmit() {
    setError(null);
    const payloadGroups = groups
      .map((g) => ({
        label: g.label,
        statementIds: statements
          .filter((s) => assignment[s.id] === g.id)
          .map((s) => s.id),
      }))
      .filter((g) => g.statementIds.length > 0);

    if (payloadGroups.length === 0) {
      setError("최소 1개 이상의 그룹에 카드를 배치해 주세요.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${slug}/sorts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participantName, groups: payloadGroups }),
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
        <h1 className="text-2xl font-bold">제출 완료</h1>
        <p className="text-slate-600">
          참여해 주셔서 감사합니다. 응답이 저장되었습니다.
        </p>
      </div>
    );
  }

  if (!started) {
    return (
      <div className="max-w-xl mx-auto py-16 space-y-6">
        <div>
          <h1 className="text-2xl font-bold">{title}</h1>
          {prompt && <p className="text-slate-600 mt-2 whitespace-pre-line">{prompt}</p>}
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
          onClick={() => setStarted(true)}
          disabled={!participantName.trim()}
          className="w-full rounded-lg bg-slate-900 px-6 py-3 text-white font-medium hover:bg-slate-700 transition-colors disabled:opacity-50"
        >
          카드 소팅 시작하기
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto py-8 px-4 space-y-6">
      <div>
        <h1 className="text-xl font-bold">{title}</h1>
        <p className="text-sm text-slate-500 mt-1">
          아래 카드를 그룹 상자로 드래그해 비슷한 것끼리 묶어 주세요.
        </p>
      </div>

      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <DropZone
          id={POOL_ID}
          className="rounded-xl border-2 border-dashed border-slate-300 p-4 min-h-[96px]"
        >
          <p className="text-xs font-medium text-slate-500 mb-2">
            미분류 카드 ({pooled.length})
          </p>
          <div className="flex flex-wrap gap-2">
            {pooled.map((s) => (
              <Card key={s.id} id={s.id} text={s.text} />
            ))}
          </div>
        </DropZone>

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
                    placeholder={`그룹 ${idx + 1} 이름 (선택)`}
                    className="flex-1 text-sm rounded-md border border-slate-300 px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
                  />
                  {groups.length > 1 && (
                    <button
                      onClick={() => removeGroup(group.id)}
                      className="text-slate-400 hover:text-red-500 text-xs"
                      aria-label="그룹 삭제"
                    >
                      삭제
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {items.map((s) => (
                    <Card key={s.id} id={s.id} text={s.text} />
                  ))}
                </div>
              </DropZone>
            );
          })}
        </div>

        <DragOverlay>
          {activeId ? (
            <div className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-lg">
              {statementById.get(activeId)?.text}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <button
        onClick={addGroup}
        className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100 transition-colors"
      >
        + 새 그룹
      </button>

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
