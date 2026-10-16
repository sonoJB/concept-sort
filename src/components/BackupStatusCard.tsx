"use client";

import { useEffect, useState } from "react";
import { formatUtcIsoAsKst } from "@/lib/kstTime";

type Status = {
  enabled: boolean;
  lastAttemptAt: string | null;
  lastResult: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  backups: { dir: string; createdAtUtc: string | null; reason: string | null; bytes: number | null; sha256: string | null; integrityCheck: string | null }[];
};

/** Read-only display of the server's automatic backups (success / failure visible at a glance). */
export default function BackupStatusCard({ slug, adminToken }: { slug: string; adminToken: string }) {
  const [status, setStatus] = useState<Status | null>(null);
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
        const data = (await res.json()) as Status;
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

  const failing = status?.lastResult === "FAILED";

  return (
    <details className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
      <summary className="cursor-pointer font-semibold">
        서버 자동 백업 상태{" "}
        {status && (
          <span className={failing ? "text-red-600" : "text-slate-500"}>
            {!status.enabled
              ? "(이 환경에서는 비활성)"
              : failing
                ? `— 마지막 시도 실패 (연속 ${status.consecutiveFailures}회)`
                : `— 정상 · 백업 ${status.backups.length}개`}
          </span>
        )}
      </summary>
      <div className="mt-3 space-y-2">
        {error && <p className="text-red-600">{error}</p>}
        {status?.enabled && (
          <>
            <p className="text-slate-600">
              마지막 성공: {status.lastSuccessAt ? formatUtcIsoAsKst(status.lastSuccessAt) : "없음"} · 마지막 시도:{" "}
              {status.lastAttemptAt ? formatUtcIsoAsKst(status.lastAttemptAt) : "없음"} ({status.lastResult ?? "-"})
            </p>
            {failing && status.lastError && (
              <p className="text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">실패 사유: {status.lastError}</p>
            )}
            <p className="text-xs text-slate-500">
              변경이 있을 때만 새 백업을 만들며, 기존 백업은 자동으로 삭제되지 않습니다. 이 목록은 서버 볼륨 안의 사본이며, 서버와
              독립된 보관본은 연구자가 내려받아 둔 백업 묶음입니다.
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
