import type { PrismaClient } from "@/generated/prisma/client";
import { DEFAULT_ANALYSIS_PARAMETERS } from "./config";
import { ACTIVE_JOB_STATUSES, MAX_PACKAGE_VERSIONS_PER_RUN, PACKAGE_JOB_MAX_ATTEMPTS, PACKAGE_JOB_MESSAGES, PACKAGE_JOB_STALE_MS, type PackageJobTrigger } from "./packageConfig";
import { PackageBuildError, buildPackageBytes } from "./packageBuild";
import { registerPackageBytes } from "./packageRegister";
import { isResultBodyExposable, serializeRunMetadata } from "./runSerializer";

export type PackageJobRow = Awaited<ReturnType<PrismaClient["analysisPackageJob"]["findUniqueOrThrow"]>>;

export type EnqueueResult =
  | { ok: true; job: PackageJobRow; created: boolean; reason: "CREATED" | "ALREADY_ACTIVE" | "PACKAGE_EXISTS" | "RETRY_REQUEUED" }
  | { ok: false; status: number; errorCode: string };

const isActive = (s: string) => (ACTIVE_JOB_STATUSES as readonly string[]).includes(s);
const isUnique = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";

/**
 * Asks for the package of a COMPLETED run to be built. The package state is separate from the analysis state and a job is
 * only ever created for a run that is complete, official (MAIN), of the current algorithm version and fully current —
 * so a package can never be attached to a stale or failed result, and the MDS is never recomputed here.
 *
 *  AUTO     right after an analysis completed (does nothing if a job or package already exists for the run)
 *  RETRY    re-queues the latest FAILED job of the run (same target version, attempt counter reset)
 *  REBUILD  a new package VERSION from the stored result (older versions are kept)
 *
 * At most one job per run is active at any time (double click / refresh / two admins cannot start two builds).
 */
export async function enqueuePackageJob(prisma: PrismaClient, runId: string, trigger: PackageJobTrigger): Promise<EnqueueResult> {
  const run = await prisma.analysisRun.findUnique({ where: { id: runId } });
  if (!run) return { ok: false, status: 404, errorCode: "RUN_NOT_FOUND" };
  if (run.executionStatus !== "COMPLETED" || !run.resultBundle) return { ok: false, status: 409, errorCode: "RUN_NOT_COMPLETED" };
  if (run.dataset !== "MAIN") return { ok: false, status: 409, errorCode: "RUN_NOT_MAIN" };
  const meta = await serializeRunMetadata(prisma, run);
  if (!isResultBodyExposable(run.executionStatus, meta.freshness) || run.algorithmVersion !== DEFAULT_ANALYSIS_PARAMETERS.algorithmVersion) return { ok: false, status: 409, errorCode: "RESULT_NOT_CURRENT" };

  const attempt = async (): Promise<EnqueueResult> =>
    prisma.$transaction(async (tx) => {
      const jobs = await tx.analysisPackageJob.findMany({ where: { analysisRunId: runId }, orderBy: { targetVersion: "desc" } });
      const pkgs = await tx.analysisPackage.findMany({ where: { analysisRunId: runId }, select: { packageVersion: true }, orderBy: { packageVersion: "desc" } });
      const active = jobs.find((j) => isActive(j.status));
      if (active) return { ok: true as const, job: active, created: false, reason: "ALREADY_ACTIVE" as const };
      const latestJob = jobs[0];
      if (trigger === "AUTO") {
        if (latestJob) return { ok: true as const, job: latestJob, created: false, reason: "PACKAGE_EXISTS" as const };
        if (pkgs.length > 0) return { ok: false as const, status: 200, errorCode: "PACKAGE_EXISTS" };
      }
      if (trigger === "RETRY") {
        if (!latestJob || latestJob.status !== "FAILED") return { ok: false as const, status: 409, errorCode: "NOTHING_TO_RETRY" };
        const r = await tx.analysisPackageJob.updateMany({ where: { id: latestJob.id, status: "FAILED" }, data: { status: "QUEUED", attempt: 0, errorCode: null, errorMessageSafe: null, finishedAt: null, startedAt: null, heartbeatAt: null, trigger: "RETRY" } });
        if (r.count !== 1) return { ok: false as const, status: 409, errorCode: "NOTHING_TO_RETRY" };
        return { ok: true as const, job: await tx.analysisPackageJob.findUniqueOrThrow({ where: { id: latestJob.id } }), created: false, reason: "RETRY_REQUEUED" as const };
      }
      if (pkgs.length >= MAX_PACKAGE_VERSIONS_PER_RUN) return { ok: false as const, status: 409, errorCode: "TOO_MANY_VERSIONS" };
      const targetVersion = Math.max(pkgs[0]?.packageVersion ?? 0, latestJob?.targetVersion ?? 0) + 1;
      const job = await tx.analysisPackageJob.create({ data: { projectId: run.projectId, analysisRunId: runId, scope: run.scope, targetVersion, status: "QUEUED", trigger } });
      return { ok: true as const, job, created: true, reason: "CREATED" as const };
    });
  try {
    return await attempt();
  } catch (e) {
    if (!isUnique(e)) throw e;
    // a concurrent request created the job first: return that one
    const j = await prisma.analysisPackageJob.findFirst({ where: { analysisRunId: runId }, orderBy: { targetVersion: "desc" } });
    if (j) return { ok: true, job: j, created: false, reason: "ALREADY_ACTIVE" };
    throw e;
  }
}

/** Atomically takes the oldest QUEUED job (QUEUED -> BUILDING). Two workers can never take the same job. */
export async function claimNextJob(prisma: PrismaClient): Promise<PackageJobRow | null> {
  const cand = await prisma.analysisPackageJob.findFirst({ where: { status: "QUEUED" }, orderBy: { createdAt: "asc" } });
  if (!cand) return null;
  const now = new Date();
  const r = await prisma.analysisPackageJob.updateMany({ where: { id: cand.id, status: "QUEUED" }, data: { status: "BUILDING", attempt: { increment: 1 }, startedAt: now, heartbeatAt: now, errorCode: null, errorMessageSafe: null, finishedAt: null } });
  return r.count === 1 ? prisma.analysisPackageJob.findUniqueOrThrow({ where: { id: cand.id } }) : null;
}

/**
 * Recovery after a server restart / crash: jobs that were in flight and stopped reporting are put back in the queue
 * (up to PACKAGE_JOB_MAX_ATTEMPTS attempts, then FAILED for a human to retry). At process start `ignoreHeartbeat` treats
 * every in-flight job as dead (this server is the only worker and was just restarted).
 */
export async function recoverStaleJobs(prisma: PrismaClient, opts: { now?: Date; ignoreHeartbeat?: boolean } = {}): Promise<{ requeued: number; failed: number }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - PACKAGE_JOB_STALE_MS);
  const inFlight = await prisma.analysisPackageJob.findMany({
    where: { status: { in: ["BUILDING", "VERIFYING", "REGISTERING"] }, ...(opts.ignoreHeartbeat ? {} : { OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null }] }) },
  });
  let requeued = 0;
  let failed = 0;
  for (const j of inFlight) {
    if (j.attempt >= PACKAGE_JOB_MAX_ATTEMPTS) {
      const r = await prisma.analysisPackageJob.updateMany({ where: { id: j.id, status: j.status }, data: { status: "FAILED", errorCode: "JOB_ABANDONED", errorMessageSafe: PACKAGE_JOB_MESSAGES.JOB_ABANDONED, finishedAt: now } });
      failed += r.count;
    } else {
      const r = await prisma.analysisPackageJob.updateMany({ where: { id: j.id, status: j.status }, data: { status: "QUEUED", heartbeatAt: null } });
      requeued += r.count;
    }
  }
  return { requeued, failed };
}

async function transition(prisma: PrismaClient, id: string, from: string[], to: string, extra: Record<string, unknown> = {}): Promise<boolean> {
  const r = await prisma.analysisPackageJob.updateMany({ where: { id, status: { in: from } }, data: { status: to, heartbeatAt: new Date(), ...extra } });
  return r.count === 1;
}

async function fail(prisma: PrismaClient, jobId: string, code: string, detail?: unknown) {
  if (detail !== undefined) console.error(`[package-job ${jobId}] ${code}`, detail);
  await prisma.analysisPackageJob.updateMany({
    where: { id: jobId, status: { in: ["QUEUED", "BUILDING", "VERIFYING", "REGISTERING"] } },
    data: { status: "FAILED", errorCode: code, errorMessageSafe: PACKAGE_JOB_MESSAGES[code] ?? PACKAGE_JOB_MESSAGES.BUILD_FAILED, finishedAt: new Date() },
  });
}

export type JobDeps = { build?: typeof buildPackageBytes };

/**
 * Runs one CLAIMED job (status BUILDING): build the ZIP from the stored result, verify it, register it as the package version
 * the job was created for, mark READY. Every step re-checks that the job is still in the expected state, so a job that was
 * cancelled, recovered or finished elsewhere is never overwritten. Technical detail goes to the server log only.
 */
export async function runPackageJob(prisma: PrismaClient, jobId: string, deps: JobDeps = {}): Promise<PackageJobRow> {
  const job = await prisma.analysisPackageJob.findUniqueOrThrow({ where: { id: jobId } });
  if (job.status !== "BUILDING") return job;
  const build = deps.build ?? buildPackageBytes;
  try {
    const run = await prisma.analysisRun.findUnique({ where: { id: job.analysisRunId } });
    if (!run || run.executionStatus !== "COMPLETED" || !run.resultBundle || run.dataset !== "MAIN" || run.algorithmVersion !== DEFAULT_ANALYSIS_PARAMETERS.algorithmVersion) {
      await fail(prisma, jobId, "RESULT_NOT_CURRENT");
      return prisma.analysisPackageJob.findUniqueOrThrow({ where: { id: jobId } });
    }
    const meta = await serializeRunMetadata(prisma, run);
    if (!isResultBodyExposable(run.executionStatus, meta.freshness)) {
      await fail(prisma, jobId, "RESULT_NOT_CURRENT");
      return prisma.analysisPackageJob.findUniqueOrThrow({ where: { id: jobId } });
    }
    const beat = async () => {
      await prisma.analysisPackageJob.updateMany({ where: { id: jobId, status: { in: ["BUILDING", "VERIFYING", "REGISTERING"] } }, data: { heartbeatAt: new Date() } });
    };
    const built = await build(prisma, run, { packageVersion: job.targetVersion, heartbeat: beat });
    if (!(await transition(prisma, jobId, ["BUILDING"], "VERIFYING"))) return prisma.analysisPackageJob.findUniqueOrThrow({ where: { id: jobId } });
    let phaseOk = true;
    const result = await registerPackageBytes(prisma, run, built.bytes, {
      targetVersion: job.targetVersion,
      requireCurrentText: true,
      onVerified: async () => {
        phaseOk = await transition(prisma, jobId, ["VERIFYING"], "REGISTERING");
        return phaseOk;
      },
    });
    if (!result.ok) {
      const code = result.errorCode === "PACKAGE_CONTAINS_PERSONAL_DATA" ? "PERSONAL_DATA_FOUND" : result.errorCode === "TOO_MANY_VERSIONS" ? "TOO_MANY_VERSIONS" : result.errorCode === "ABORTED" ? "" : "VERIFY_FAILED";
      if (code) await fail(prisma, jobId, code, { errorCode: result.errorCode, detail: result.detail });
      return prisma.analysisPackageJob.findUniqueOrThrow({ where: { id: jobId } });
    }
    await transition(prisma, jobId, ["REGISTERING", "VERIFYING"], "READY", { finishedAt: new Date(), errorCode: null, errorMessageSafe: null });
  } catch (e) {
    if (e instanceof PackageBuildError) await fail(prisma, jobId, e.code, e.detail);
    else await fail(prisma, jobId, "REGISTER_FAILED", e instanceof Error ? e.stack ?? e.message : String(e));
  }
  return prisma.analysisPackageJob.findUniqueOrThrow({ where: { id: jobId } });
}

/** Claims and runs the next queued job, if any. */
export async function processNextPackageJob(prisma: PrismaClient, deps: JobDeps = {}): Promise<PackageJobRow | null> {
  const job = await claimNextJob(prisma);
  return job ? runPackageJob(prisma, job.id, deps) : null;
}

/** API view of a job (no internal detail; the error text is one of the fixed PACKAGE_JOB_MESSAGES). */
export function serializePackageJob(j: PackageJobRow) {
  return {
    id: j.id,
    runId: j.analysisRunId,
    scope: j.scope,
    targetVersion: j.targetVersion,
    status: j.status,
    active: isActive(j.status),
    trigger: j.trigger,
    attempt: j.attempt,
    errorCode: j.errorCode,
    errorMessageSafe: j.errorMessageSafe,
    createdAt: j.createdAt.toISOString(),
    startedAt: j.startedAt?.toISOString() ?? null,
    heartbeatAt: j.heartbeatAt?.toISOString() ?? null,
    finishedAt: j.finishedAt?.toISOString() ?? null,
  };
}
