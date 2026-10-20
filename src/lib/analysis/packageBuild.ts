import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { DEFAULT_ANALYSIS_PARAMETERS } from "./config";
import { canonicalHash } from "./canonicalJson";
import { PACKAGE_BUILD_TIMEOUT_MS, PACKAGE_FORMAT_VERSION, PACKAGE_MIN_FREE_BYTES } from "./packageConfig";
import { PackageInputChangedError, loadPackageRaw } from "./packageRaw";
import { packageStorageDir } from "./packageStore";
import { isResultBodyExposable, serializeRunMetadata } from "./runSerializer";
import type { ResultBundle } from "@/lib/conceptMap/bundle";
import { withCurrentInterpretation } from "@/lib/conceptMap/bundleView";

/** A failure of the build step with a stable code (see PACKAGE_JOB_MESSAGES); `detail` is for the server log only. */
export class PackageBuildError extends Error {
  constructor(public code: string, public detail?: string) {
    super(code);
    this.name = "PackageBuildError";
  }
}

export type RunForBuild = { id: string; projectId: string; scope: string; inputSnapshot: string; resultBundle: string | null };

const ENV_PYTHON = "PACKAGE_BUILDER_PYTHON";

export function builderPython(): string {
  return process.env[ENV_PYTHON] || (process.platform === "win32" ? "python" : "python3");
}

function freeBytes(dir: string): number {
  fs.mkdirSync(dir, { recursive: true });
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/**
 * Bundles of the KR and JP runs that belong to the SAME data as an ALL run (needed only for the Korea–Japan comparison
 * figures of the ALL package). A companion is used only if its own participants fingerprint equals the fingerprint of the
 * ALL run's participants of that country — otherwise it is left out instead of being mixed in.
 */
async function companionBundles(prisma: PrismaClient, run: RunForBuild, participants: { country: string }[]): Promise<Record<"KR" | "JP", ResultBundle | null>> {
  const out: Record<"KR" | "JP", ResultBundle | null> = { KR: null, JP: null };
  for (const country of ["KR", "JP"] as const) {
    const runs = await prisma.analysisRun.findMany({ where: { projectId: run.projectId, scope: country, dataset: "MAIN", executionStatus: "COMPLETED", algorithmVersion: DEFAULT_ANALYSIS_PARAMETERS.algorithmVersion }, orderBy: { startedAt: "desc" } });
    for (const r of runs) {
      if (!r.resultBundle) continue;
      const meta = await serializeRunMetadata(prisma, r);
      if (!isResultBodyExposable(r.executionStatus, meta.freshness)) continue;
      const b = JSON.parse(r.resultBundle) as ResultBundle;
      const mine = (JSON.parse(run.inputSnapshot).participants as { country: string }[]).filter((p) => p.country === country);
      if (canonicalHash(mine) === b.meta.fingerprints.participantsHash) out[country] = b;
      break; // only the newest current run of that country is a candidate
    }
  }
  void participants;
  return out;
}

/** Evidence files (cross-checks computed once for a specific dataset) are included only for the data they were computed on. */
function prepareEvidence(repoRoot: string, work: string, scope: string, fp: { numericDataHash: string; participantsHash: string }): string {
  const dir = path.join(work, "evidence");
  fs.mkdirSync(dir, { recursive: true });
  try {
    const applies = JSON.parse(fs.readFileSync(path.join(repoRoot, "docs", "mds-reanalysis", "evidence-applies-to.json"), "utf8")) as Record<string, { numericDataHash: string; participantsHash: string }>;
    const a = applies[scope];
    if (a && a.numericDataHash === fp.numericDataHash && a.participantsHash === fp.participantsHash) {
      const src = path.join(repoRoot, "docs", "mds-reanalysis", "evidence");
      for (const name of fs.readdirSync(src)) if (name.endsWith(".json")) fs.copyFileSync(path.join(src, name), path.join(dir, name));
    }
  } catch {
    /* no evidence applies — the verification report says so */
  }
  return dir;
}

/**
 * Builds the package ZIP of a COMPLETED run with the Python package builder (scripts/package/build_packages.py) from the
 * run's STORED result bundle and input snapshot. The analysis is never recomputed: no MDS runs here.
 */
export async function buildPackageBytes(
  prisma: PrismaClient,
  run: RunForBuild,
  opts: { packageVersion: number; heartbeat?: () => Promise<void>; repoRoot?: string; timeoutMs?: number }
): Promise<{ bytes: Uint8Array; filename: string }> {
  if (!run.resultBundle) throw new PackageBuildError("RESULT_NOT_CURRENT");
  const repoRoot = opts.repoRoot ?? process.cwd();
  const script = path.join(repoRoot, "scripts", "package", "build_packages.py");
  if (!fs.existsSync(script)) throw new PackageBuildError("BUILDER_UNAVAILABLE", `missing ${script}`);
  try {
    if (freeBytes(packageStorageDir()) < PACKAGE_MIN_FREE_BYTES || freeBytes(os.tmpdir()) < PACKAGE_MIN_FREE_BYTES) throw new PackageBuildError("DISK_LOW");
  } catch (e) {
    if (e instanceof PackageBuildError) throw e;
    throw new PackageBuildError("BUILD_FAILED", `free-space check failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pkgbuild-"));
  try {
    const bundlesDir = path.join(work, "bundles");
    const outDir = path.join(work, "out");
    fs.mkdirSync(bundlesDir);
    fs.mkdirSync(outDir);
    const bundle = withCurrentInterpretation(JSON.parse(run.resultBundle) as ResultBundle);
    fs.writeFileSync(path.join(bundlesDir, `bundle_${run.scope}.json`), JSON.stringify({ bundle }));

    let raw;
    try {
      raw = await loadPackageRaw(prisma, run);
    } catch (e) {
      if (e instanceof PackageInputChangedError) throw new PackageBuildError("PACKAGE_INPUT_CHANGED", e.message);
      throw e;
    }
    fs.writeFileSync(path.join(work, "raw.json"), JSON.stringify(raw));

    if (run.scope === "ALL") {
      const comp = await companionBundles(prisma, run, raw.participants);
      for (const c of ["KR", "JP"] as const) if (comp[c]) fs.writeFileSync(path.join(bundlesDir, `bundle_${c}.json`), JSON.stringify({ bundle: withCurrentInterpretation(comp[c]!) }));
    }
    const evidence = prepareEvidence(repoRoot, work, run.scope, { numericDataHash: bundle.meta.fingerprints.numericDataHash, participantsHash: bundle.meta.fingerprints.participantsHash });

    const args = [
      "-X", "utf8", script,
      "--bundles", bundlesDir, "--raw", path.join(work, "raw.json"), "--out", outDir, "--repo", repoRoot, "--evidence", evidence,
      "--scopes", run.scope, "--package-version", String(opts.packageVersion), "--package-format", PACKAGE_FORMAT_VERSION,
    ];
    const mpl = path.join(os.tmpdir(), "concept-sort-mplconfig");
    fs.mkdirSync(mpl, { recursive: true });
    const result = await new Promise<{ code: number | null; log: string; stdout: string; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(builderPython(), args, { cwd: repoRoot, env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", MPLBACKEND: "Agg", MPLCONFIGDIR: mpl }, stdio: ["ignore", "pipe", "pipe"] });
      let log = "";
      let stdout = "";
      const keep = (b: Buffer) => {
        log = (log + b.toString("utf8")).slice(-12000);
      };
      child.stdout.on("data", (b: Buffer) => {
        stdout += b.toString("utf8");
        keep(b);
      });
      child.stderr.on("data", keep);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs ?? PACKAGE_BUILD_TIMEOUT_MS);
      const beat = opts.heartbeat ? setInterval(() => void opts.heartbeat!().catch(() => {}), 30_000) : null;
      child.on("error", (err) => {
        clearTimeout(timer);
        if (beat) clearInterval(beat);
        reject(new PackageBuildError("BUILDER_UNAVAILABLE", err.message));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (beat) clearInterval(beat);
        resolve({ code, log, stdout, timedOut });
      });
    });
    if (result.timedOut) throw new PackageBuildError("BUILD_TIMEOUT", result.log.slice(-2000));
    if (result.code !== 0) throw new PackageBuildError("BUILD_FAILED", `exit ${result.code}: ${result.log.slice(-4000)}`);
    const zips = fs.readdirSync(outDir).filter((n) => n.endsWith(".zip"));
    if (zips.length !== 1) throw new PackageBuildError("BUILD_FAILED", `expected one zip, found ${zips.length}`);
    // the builder prints a JSON summary; its own checks (zip test, every file hash, independent reproduction) must all hold
    try {
      const summary = JSON.parse(result.stdout.slice(Math.max(0, result.stdout.search(/^\{/m)))) as Record<string, { testzip: unknown; all_hashes_ok: boolean; independent_reproduction: boolean | null }>;
      const s = summary[run.scope];
      if (!s || s.testzip !== null || !s.all_hashes_ok || s.independent_reproduction !== true) throw new Error("builder self-check failed");
    } catch (e) {
      throw new PackageBuildError("BUILD_FAILED", `builder self-check: ${e instanceof Error ? e.message : String(e)}; log tail: ${result.log.slice(-1500)}`);
    }
    return { bytes: new Uint8Array(fs.readFileSync(path.join(outDir, zips[0]))), filename: zips[0] };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
