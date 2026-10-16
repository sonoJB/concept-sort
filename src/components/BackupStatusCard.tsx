"use client";

import { useEffect, useState } from "react";
import { formatUtcIsoAsKst } from "@/lib/kstTime";
import type { BackupStatus, HealthIssue } from "@/lib/backupStatus";

const ISSUE_TEXT: Record<HealthIssue, string> = {
  FAILING: "백업 시도 실패",
  CHECKS_STOPPED: "백업 점검 중단 의심",
  NO_VERIFIED_COPY: "검증된 정상 사본 없음",
  LOW_DISK: "저장공간 부족",
};

const mb = (n: number | null) => (n === null ? "알 수 없음" : `${Math.round(n / 1048576)} MB`);
const when = (iso: string | null) => (iso ? formatUtcIsoAsKst(iso) : "없음");

/** Read-only display of the server's automatic backups. Failures are only visible when someone opens this screen. */
export default function BackupStatusCard({ slug, adminToken }: { slug: string; adminToken: string }) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/backup-status`, {
          headers: { "x-admin-token": adminToken },
          cache: "no-store",
        });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as BackupStatus;
        if (!cancelled) setStatus(data);
      } catch {
        if (!cancelled) setError("백업 상태를 불러오지 못했습니다.");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, adminToken]);

  const level = status?.health.level;
  const tone = level === "error" ? "text-red-600" : level === "warn" ? "text-amber-600" : "text-slate-500";

  return (
    <details className="rounded-xl border border-slate-200 bg-white p-4 text-sm" open={level === "error" || level === "warn"}>
      <summary className="cursor-pointer font-semibold">
        서버 자동 백업 상태{" "}
        {status && (
          <span className={tone}>
            {!status.enabled
              ? "(이 환경에서는 비활성)"
              : status.health.issues.length
                ? `— 확인 필요: ${status.health.issues.map((i) => ISSUE_TEXT[i]).join(" · ")}`
                : status.health.unchangedSinceLastBackup
                  ? "— 정상 (마지막 백업 이후 원자료 변경 없음)"
                  : "— 정상"}
          </span>
        )}
      </summary>
      <div className="mt-3 space-y-2">
        {error && <p className="text-red-600">{error}</p>}
        {status?.maintenanceMode && (
          <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            점검 모드(MAINTENANCE) 켜짐 — 참여자 제출이 차단되어 있습니다.
          </p>
        )}
        {status?.enabled && (
          <>
            <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr] text-slate-700">
              <dt className="text-slate-500">최근 점검 시각</dt>
              <dd>
                {when(status.lastCheckAt)}
                {status.checkAgeHours !== null && <span className="text-slate-400"> ({status.checkAgeHours}시간 전)</span>}
                <span className="text-slate-400"> · 결과 {status.lastCheckResult ?? "-"}</span>
              </dd>
              <dt className="text-slate-500">최근 백업 생성 시각</dt>
              <dd>
                {when(status.lastBackupAt)}
                {status.health.unchangedSinceLastBackup && <span className="text-slate-400"> · 이후 원자료 변경이 없어 새로 만들지 않음</span>}
              </dd>
              <dt className="text-slate-500">정상 사본 존재·검증</dt>
              <dd className={status.lastVerifiedOk ? "" : "text-red-600"}>
                {status.lastVerifiedOk === null
                  ? "검증 기록 없음"
                  : status.lastVerifiedOk
                    ? `예 — ${status.lastVerifiedBackup} (파일·SHA-256·무결성·스키마 이력 재검증 ${when(status.lastVerifiedAt)})`
                    : `아니오 — ${status.lastVerifiedProblems.join("; ") || "원인 미상"}`}
              </dd>
              <dt className="text-slate-500">연속 실패</dt>
              <dd className={status.consecutiveFailures > 0 ? "text-red-600" : ""}>
                {status.consecutiveFailures}회{status.lastError ? ` — ${status.lastError}` : ""}
              </dd>
              <dt className="text-slate-500">저장공간</dt>
              <dd className={status.lowDisk ? "text-amber-700" : ""}>
                남은 용량 {mb(status.freeBytes)}
                {status.lowDisk ? " — 부족 (100 MB 미만이면 새 백업을 만들지 않고 실패로 기록)" : ""}
              </dd>
            </dl>
            <p className="text-xs text-slate-500">
              변경이 있을 때만 새 백업을 만들며 기존 백업은 자동 삭제되지 않습니다. 이 목록은 서버 볼륨 안의 사본입니다. 읽기 전용
              속성은 실수 방지용일 뿐 변경·삭제를 막는 불변 보관이 아닙니다. 이 화면을 열어 보아야만 실패를 알 수 있고, 서버가 꺼져
              있으면 자동 백업도 동작하지 않습니다.
            </p>
            <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
              {status.backups.map((b) => (
                <li key={b.dir} className="px-3 py-2 flex flex-wrap gap-x-4 gap-y-1">
                  <span className="font-mono text-xs">{b.dir}</span>
                  <span className="text-xs text-slate-500">
                    {b.bytes ? `${(b.bytes / 1048576).toFixed(2)} MB` : ""} {b.integrityCheck ? `· 무결성 ${b.integrityCheck}` : ""}
                  </span>
                  {b.sha256 && <span className="font-mono text-[10px] text-slate-400 break-all">sha256 {b.sha256}</span>}
                </li>
              ))}
              {status.backups.length === 0 && <li className="px-3 py-2 text-slate-500">아직 백업이 없습니다.</li>}
            </ul>
          </>
        )}
      </div>
    </details>
  );
}
