import type { PrismaClient } from "@/generated/prisma/client";

export class RunAlreadyRunningError extends Error {
  constructor() {
    super("An AnalysisRun is already RUNNING for this project+scope.");
    this.name = "RunAlreadyRunningError";
  }
}

/** True if the error is a Prisma unique-constraint violation (P2002), without importing Prisma's error class directly (keeps this file runtime-agnostic for tests). */
function isUniqueConstraintError(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === "P2002";
}

/**
 * Orphan recovery: a RUNNING AnalysisRun whose lock has outlived
 * `timeoutMs` since acquisition is treated as abandoned (server crash mid-
 * execution, since `finally` never ran). Transitions the run to FAILED and
 * removes the lock, atomically. Read paths call this lazily before trusting
 * any RUNNING row; there is no background sweeper.
 */
export async function recoverOrphanLocks(prisma: PrismaClient, timeoutMs: number, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - timeoutMs);
  const staleLocks = await prisma.analysisExecutionLock.findMany({
    where: { acquiredAt: { lt: cutoff } },
    include: { analysisRun: true },
  });

  let recovered = 0;
  for (const lock of staleLocks) {
    if (lock.analysisRun.executionStatus === "RUNNING") {
      await prisma.$transaction(async (tx) => {
        await tx.analysisRun.update({
          where: { id: lock.analysisRunId },
          data: { executionStatus: "FAILED", errorCode: "SERVER_INTERRUPTED", errorMessageSafe: "The server was interrupted before this analysis run could complete.", finishedAt: now },
        });
        await tx.analysisExecutionLock.delete({ where: { id: lock.id } });
      });
      recovered++;
    } else {
      // Terminal run, lock just never got cleaned up (e.g. crash between
      // terminal-state write and lock delete) — safe to drop the lock alone.
      await prisma.analysisExecutionLock.delete({ where: { id: lock.id } }).catch(() => {
        // Already deleted by a concurrent recovery pass — not an error.
      });
      recovered++;
    }
  }
  return recovered;
}

export { isUniqueConstraintError };
