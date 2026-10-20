import type { PrismaClient } from "@/generated/prisma/client";
import { DEFAULT_ANALYSIS_PARAMETERS } from "./config";
import { readPackageFile } from "./packageStore";
import { verifyPackageBytes } from "./packageVerify";
import { isResultBodyExposable, serializeRunMetadata } from "./runSerializer";

/**
 * Algorithm versions whose results were found to be wrong and may be replaced. A version is listed here only
 * because the defect was reproduced (v1: every start stopped at iteration 2 as STRESS_INCREASED while raw stress was
 * still falling; unconverged results could be selected; termination reasons were not kept). "Not the current version"
 * alone is never a reason to delete anything.
 */
export const ERRONEOUS_ALGORITHM_VERSIONS = ["1.0.0"] as const;
/** Only the official 본조사 analyses of these scopes are ever eligible. Pilot / check-up / legacy runs are never touched. */
export const CLEANUP_SCOPES = ["KR", "JP", "ALL"] as const;
export const CLEANUP_DATASET = "MAIN";

export type CleanupTarget = { id: string; scope: string; dataset: string; algorithmVersion: string; startedAt: string; executionStatus: string; dimensions: number; interpretations: number; packages: number };

export async function listCleanupTargets(prisma: PrismaClient, projectId: string): Promise<CleanupTarget[]> {
  const rows = await prisma.analysisRun.findMany({
    where: { projectId, dataset: CLEANUP_DATASET, scope: { in: [...CLEANUP_SCOPES] }, algorithmVersion: { in: [...ERRONEOUS_ALGORITHM_VERSIONS] } },
    orderBy: [{ scope: "asc" }, { startedAt: "asc" }],
    select: { id: true, scope: true, dataset: true, algorithmVersion: true, startedAt: true, executionStatus: true, _count: { select: { dimensions: true, interpretations: true, packages: true } } },
  });
  return rows.map((r) => ({ id: r.id, scope: r.scope, dataset: r.dataset, algorithmVersion: r.algorithmVersion, startedAt: r.startedAt.toISOString(), executionStatus: r.executionStatus, dimensions: r._count.dimensions, interpretations: r._count.interpretations, packages: r._count.packages }));
}

type Bundle = {
  meta: { N: number; nKr: number; nJp: number; statementCount: number; fingerprints: { participantsHash: string; numericDataHash: string; parameterHash: string; statementStructureHash: string } };
  analysis: { S: number[][]; primary: { numericallyConverged: boolean; selected: { main: { reason: string }; strict: { reason: string } } | null; coordinates: number[][] | null }; pairDiagnostics: unknown[] | null; ward: unknown | null };
};

export type PreconditionReport = { ok: boolean; problems: string[]; perScope: Record<string, { runId: string | null; converged: boolean; packageVerified: boolean; packageBytes: number | null; packageFiles: number | null }> };

/**
 * Everything that must hold BEFORE any superseded result may be deleted: for each of KR / JP / ALL a current,
 * fresh, COMPLETED MAIN run whose 2D solution converged (both phases), with pair diagnostics and Ward present, a
 * package whose file exists on disk, matches its recorded SHA-256 and passes the full manifest check (run id,
 * fingerprints, every file hash, no unlisted files) — and the three runs must describe the same data
 * (N and S of ALL equal KR + JP).
 */
export async function verifyCurrentResults(prisma: PrismaClient, projectId: string): Promise<PreconditionReport> {
  const problems: string[] = [];
  const perScope: PreconditionReport["perScope"] = {};
  const bundles: Record<string, Bundle> = {};
  for (const scope of CLEANUP_SCOPES) {
    const info = { runId: null as string | null, converged: false, packageVerified: false, packageBytes: null as number | null, packageFiles: null as number | null };
    perScope[scope] = info;
    const runs = await prisma.analysisRun.findMany({
      where: { projectId, scope, dataset: CLEANUP_DATASET, algorithmVersion: DEFAULT_ANALYSIS_PARAMETERS.algorithmVersion, executionStatus: "COMPLETED" },
      orderBy: { startedAt: "desc" },
      include: { packages: { orderBy: { packageVersion: "desc" } } }, // the CURRENT package version is the first
    });
    let chosen: (typeof runs)[number] | null = null;
    for (const r of runs) {
      const meta = await serializeRunMetadata(prisma, r);
      if (isResultBodyExposable(r.executionStatus, meta.freshness)) {
        chosen = r;
        break;
      }
    }
    if (!chosen) {
      problems.push(`${scope}: no current, fresh COMPLETED MAIN run of version ${DEFAULT_ANALYSIS_PARAMETERS.algorithmVersion}`);
      continue;
    }
    info.runId = chosen.id;
    const bundle = chosen.resultBundle ? (JSON.parse(chosen.resultBundle) as Bundle) : null;
    if (!bundle) {
      problems.push(`${scope}: result bundle missing`);
      continue;
    }
    bundles[scope] = bundle;
    const p = bundle.analysis.primary;
    info.converged = p.numericallyConverged === true && p.selected?.main.reason === "CONVERGED" && p.selected?.strict.reason === "CONVERGED" && p.coordinates !== null;
    if (!info.converged) problems.push(`${scope}: primary 2D solution did not converge in both phases`);
    if (!bundle.analysis.pairDiagnostics || !bundle.analysis.ward) problems.push(`${scope}: pair diagnostics or Ward result missing`);
    const pkg = chosen.packages[0];
    if (!pkg) {
      problems.push(`${scope}: no package attached`);
      continue;
    }
    const bytes = readPackageFile(pkg.storedFile, pkg.sha256);
    if (!bytes) {
      problems.push(`${scope}: package file missing on disk or SHA-256 mismatch`);
      continue;
    }
    info.packageBytes = bytes.byteLength;
    const check = verifyPackageBytes(bytes, { id: chosen.id, scope: chosen.scope }, bundle.meta.fingerprints, JSON.parse(chosen.inputSnapshot));
    if (!check.ok) {
      problems.push(`${scope}: package verification failed (${check.errorCode}${check.detail ? `: ${JSON.stringify(check.detail)}` : ""})`);
      continue;
    }
    info.packageVerified = true;
    info.packageFiles = check.entryCount;
  }
  if (bundles.KR && bundles.JP && bundles.ALL) {
    const { KR, JP, ALL } = bundles;
    if (KR.meta.N + JP.meta.N !== ALL.meta.N) problems.push("N(KR) + N(JP) != N(ALL)");
    if (ALL.meta.nKr !== KR.meta.N || ALL.meta.nJp !== JP.meta.N) problems.push("country counts of the ALL run do not match the KR / JP runs");
    if (KR.meta.statementCount !== ALL.meta.statementCount || JP.meta.statementCount !== ALL.meta.statementCount) problems.push("statement counts differ between scopes");
    if (KR.meta.fingerprints.statementStructureHash !== ALL.meta.fingerprints.statementStructureHash || JP.meta.fingerprints.statementStructureHash !== ALL.meta.fingerprints.statementStructureHash) problems.push("statement structure differs between scopes");
    const n = ALL.analysis.S.length;
    let sumOk = true;
    for (let i = 0; i < n && sumOk; i++) for (let j = 0; j < n; j++) if (ALL.analysis.S[i][j] !== KR.analysis.S[i][j] + JP.analysis.S[i][j]) { sumOk = false; break; }
    if (!sumOk) problems.push("S(ALL) != S(KR) + S(JP)");
  }
  return { ok: problems.length === 0, problems, perScope };
}
