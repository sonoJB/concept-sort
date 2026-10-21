import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { buildPackageZip } from "./testSupport/packageFixture";

const dbFile = path.join(os.tmpdir(), `concept-sort-pkgpipe-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
const MIGRATIONS_DIR = path.resolve(process.cwd(), "prisma/migrations");
{
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA foreign_keys = ON;");
  const names = fs.readdirSync(MIGRATIONS_DIR).filter((n) => /^\d{14}_/.test(n)).sort();
  for (const name of names) db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf-8"));
  db.close();
}
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.ANALYSIS_ENGINE_SOURCE_COMMIT_SHA = "c".repeat(40);

const { prisma } = await import("@/lib/db");
const packageRoute = await import("@/app/api/projects/[slug]/analysis/runs/[runId]/package/route");
const jobRoute = await import("@/app/api/projects/[slug]/analysis/runs/[runId]/package-job/route");
const bundleRoute = await import("@/app/api/projects/[slug]/analysis/runs/[runId]/bundle/route");
const overviewRoute = await import("@/app/api/projects/[slug]/analysis/overview/route");
const { createAnalysisRun, executeAnalysisRun } = await import("@/lib/analysis/executionService");
const { DEFAULT_ANALYSIS_PARAMETERS, VALIDATION_BASELINE_SHA } = await import("@/lib/analysis/config");
const jobs = await import("@/lib/analysis/packageJobs");
const { PackageBuildError } = await import("@/lib/analysis/packageBuild");
const { loadPackageRaw, PackageInputChangedError } = await import("@/lib/analysis/packageRaw");
const { INTERPRETATION_TEXT_VERSION } = await import("@/lib/conceptMap/metrics");
const { PACKAGE_FORMAT_VERSION, MAX_PACKAGE_VERSIONS_PER_RUN, PACKAGE_JOB_MAX_ATTEMPTS } = await import("@/lib/analysis/packageConfig");
const { sha256Hex } = await import("@/lib/analysis/packageStore");

const SLUG = "pkgpipe";
const TOKEN = `token-${SLUG}`;
const N_ST = 12;
const REAL_NAME = "REAL-NAME-SHOULD-NEVER-LEAK";
const REAL_PHONE = "010-9999-8888";

const req = (url: string, init?: RequestInit) => new NextRequest(`http://localhost${url}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) } } as never);
const ctx = (extra: Record<string, string> = {}) => ({ params: Promise.resolve({ slug: SLUG, ...extra }) });

let seed = 11;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const ids: string[] = [];
let projectId = "";
async function makeSession(country: "KR" | "JP", name = REAL_NAME) {
  const pile = ids.map((_, s) => (rnd() < 0.15 ? Math.floor(rnd() * 3) : Math.floor(s / 4)));
  const groups = [0, 1, 2].map((g) => ids.filter((_, s) => pile[s] === g)).filter((g) => g.length > 0);
  return prisma.sortSession.create({
    data: {
      projectId, participantName: name, gender: "x", age: 20, schoolLevel: "x", grade: "x", phoneNumber: REAL_PHONE, countryCode: country, dataRole: "MAIN",
      groups: { create: groups.map((g, i) => ({ label: `묶음 ${i + 1}`, items: { create: g.map((statementId) => ({ statementId })) } })) },
    },
  });
}
{
  const project = await prisma.project.create({ data: { slug: SLUG, adminToken: TOKEN, title: "t", prompt: "p", consentKo: "c", koPreviewConfirmedAt: new Date(), titleJa: "t", promptJa: "p", consentJa: "c", jaPreviewConfirmedAt: new Date() } });
  projectId = project.id;
  for (let i = 0; i < N_ST; i++) ids.push((await prisma.statement.create({ data: { projectId, text: `문항 ${i}`, textJa: `項目 ${i}`, jaStatus: "APPROVED", order: i } })).id);
  for (let i = 0; i < 7; i++) await makeSession("KR");
  for (let i = 0; i < 9; i++) await makeSession("JP");
}

const LIGHT = { ...DEFAULT_ANALYSIS_PARAMETERS, dimensionsEvaluated: [1, 2, 3], nInit: 8, maxIter: 3000, strictMaxIter: 6000, splitHalfRepetitions: 100 };
async function analyse(scope: "KR" | "JP" | "ALL") {
  const { runId } = await createAnalysisRun({ prisma, projectId, scope, dataset: "MAIN", analysisParameters: LIGHT, validationBaselineSha: VALIDATION_BASELINE_SHA, engineSourceCommitSha: "c".repeat(40) });
  await executeAnalysisRun(prisma, runId);
  return prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
}

/** A builder that returns a valid ZIP for the run without starting Python (the real builder is exercised separately). */
const fakeBuild = (opts: { text?: string | null } = {}) =>
  (async (_p: unknown, run: { id: string; scope: string; inputSnapshot: string; resultBundle: string | null }, o: { packageVersion: number }) => ({
    bytes: buildPackageZip(run, { extraManifest: { packageVersion: o.packageVersion, packageFormatVersion: PACKAGE_FORMAT_VERSION, interpretationTextVersion: opts.text === undefined ? INTERPRETATION_TEXT_VERSION : opts.text }, zipFilename: `${run.scope}_v${o.packageVersion}.zip` }),
    filename: "x.zip",
  })) as unknown as typeof import("@/lib/analysis/packageBuild").buildPackageBytes;

const overview = async () => (await (await overviewRoute.GET(req(`/api/projects/${SLUG}/analysis/overview`), ctx())).json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const download = async (runId: string, version?: number) => packageRoute.GET(req(`/api/projects/${SLUG}/analysis/runs/${runId}/package${version !== undefined ? `?version=${version}` : ""}`), ctx({ runId }));

describe("analysis -> ZIP pipeline (queue, build, verify, register, ready)", () => {
  it("an analysis that completes queues exactly one AUTO package job; analysis state and package state are separate", async () => {
    const run = await analyse("KR");
    expect(run.executionStatus).toBe("COMPLETED");
    const list = await prisma.analysisPackageJob.findMany({ where: { analysisRunId: run.id } });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "QUEUED", trigger: "AUTO", targetVersion: 1, attempt: 0 });
    // the run is already official and visible while its package is not ready; its download is simply not available yet
    const o = await overview();
    expect(o.scopes.KR.official.id).toBe(run.id);
    expect(o.scopes.KR.package).toBeNull();
    expect(o.scopes.KR.packageJob.status).toBe("QUEUED");
    expect((await download(run.id)).status).toBe(404);
    // asking again (double click / refresh / two admins) never creates a second job
    for (let i = 0; i < 3; i++) {
      const again = await jobs.enqueuePackageJob(prisma, run.id, "AUTO");
      expect(again.ok && again.job.id).toBe(list[0].id);
    }
    const viaRoute = await jobRoute.POST(req("/", { method: "POST", body: JSON.stringify({ action: "rebuild" }) }), ctx({ runId: run.id }));
    expect((await viaRoute.json()).job.id).toBe(list[0].id); // a job is active: the same one is returned
    expect(await prisma.analysisPackageJob.count({ where: { analysisRunId: run.id } })).toBe(1);
  });

  it("the worker claims a job exclusively and takes it QUEUED -> BUILDING -> VERIFYING -> REGISTERING -> READY", async () => {
    const run = await prisma.analysisRun.findFirstOrThrow({ where: { scope: "KR" } });
    const [a, b] = await Promise.all([jobs.claimNextJob(prisma), jobs.claimNextJob(prisma)]);
    expect([a, b].filter(Boolean)).toHaveLength(1); // two workers can never take the same job
    const claimed = (a ?? b)!;
    expect(claimed.status).toBe("BUILDING");
    expect(claimed.attempt).toBe(1);
    const seen: string[] = [];
    const watching = (async (p: never, r: never, o: never) => {
      seen.push((await prisma.analysisPackageJob.findUniqueOrThrow({ where: { id: claimed.id } })).status);
      return fakeBuild()(p, r, o);
    }) as unknown as typeof import("@/lib/analysis/packageBuild").buildPackageBytes;
    const done = await jobs.runPackageJob(prisma, claimed.id, { build: watching });
    expect(seen).toEqual(["BUILDING"]);
    expect(done.status).toBe("READY");
    const pkgs = await prisma.analysisPackage.findMany({ where: { analysisRunId: run.id } });
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]).toMatchObject({ packageVersion: 1, builderVersion: PACKAGE_FORMAT_VERSION, textVersion: INTERPRETATION_TEXT_VERSION, scope: "KR" });
    expect((await prisma.analysisRun.findUniqueOrThrow({ where: { id: run.id } })).executionStatus).toBe("COMPLETED");
    const res = await download(run.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Package-Version")).toBe("1");
    expect(sha256Hex(new Uint8Array(await res.arrayBuffer()))).toBe(pkgs[0].sha256);
    const o = await overview();
    expect(o.scopes.KR.package.version).toBe(1);
    expect(o.scopes.KR.packageJob.status).toBe("READY");
    // nothing is left to do
    expect(await jobs.processNextPackageJob(prisma, { build: fakeBuild() })).toBeNull();
  });

  it("a failed build leaves the analysis untouched, shows a safe message, and a retry rebuilds WITHOUT recomputing the MDS", async () => {
    const run = await analyse("JP");
    const dimsBefore = await prisma.analysisRunDimension.count();
    const runsBefore = await prisma.analysisRun.count();
    const boom = (async () => {
      throw new PackageBuildError("BUILD_FAILED", "secret stderr: C:\\internal\\path and a stack trace");
    }) as unknown as typeof import("@/lib/analysis/packageBuild").buildPackageBytes;
    const failed = await jobs.processNextPackageJob(prisma, { build: boom });
    expect(failed).toMatchObject({ analysisRunId: run.id, status: "FAILED", errorCode: "BUILD_FAILED" });
    expect(failed!.errorMessageSafe).not.toContain("secret");
    expect(failed!.errorMessageSafe).not.toContain("internal");
    expect((await prisma.analysisRun.findUniqueOrThrow({ where: { id: run.id } })).executionStatus).toBe("COMPLETED");
    expect((await download(run.id)).status).toBe(404);
    expect((await overview()).scopes.JP.packageJob.status).toBe("FAILED");
    // nothing to retry on a run whose job did not fail
    const krRun = await prisma.analysisRun.findFirstOrThrow({ where: { scope: "KR" } });
    expect((await jobs.enqueuePackageJob(prisma, krRun.id, "RETRY")).ok).toBe(false);
    // retry through the route: same job, re-queued, then built
    const r = await jobRoute.POST(req("/", { method: "POST", body: JSON.stringify({ action: "retry" }) }), ctx({ runId: run.id }));
    expect(r.status).toBe(202);
    const body = await r.json();
    expect(body.job.id).toBe(failed!.id);
    expect(body.job.status).toBe("QUEUED");
    const ok = await jobs.processNextPackageJob(prisma, { build: fakeBuild() });
    expect(ok).toMatchObject({ id: failed!.id, status: "READY", errorCode: null });
    expect(await prisma.analysisRunDimension.count()).toBe(dimsBefore);
    expect(await prisma.analysisRun.count()).toBe(runsBefore); // no analysis was started by the retry
  });

  it("a server restart / crash mid-job is recovered; a job that keeps dying is left FAILED for a human", async () => {
    const run = await analyse("ALL");
    const job = (await prisma.analysisPackageJob.findFirstOrThrow({ where: { analysisRunId: run.id } }));
    // simulate: claimed (BUILDING) and then the process died without a heartbeat for a long time
    await jobs.claimNextJob(prisma);
    await prisma.analysisPackageJob.update({ where: { id: job.id }, data: { heartbeatAt: new Date(Date.now() - 60 * 60 * 1000) } });
    expect(await jobs.recoverStaleJobs(prisma)).toEqual({ requeued: 1, failed: 0 });
    expect((await prisma.analysisPackageJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("QUEUED");
    // a fresh heartbeat is NOT recovered while a worker is alive ...
    await jobs.claimNextJob(prisma);
    expect(await jobs.recoverStaleJobs(prisma)).toEqual({ requeued: 0, failed: 0 });
    // ... but at process start every in-flight job of the previous process is
    expect(await jobs.recoverStaleJobs(prisma, { ignoreHeartbeat: true })).toEqual({ requeued: 1, failed: 0 });
    // attempts are bounded
    await prisma.analysisPackageJob.update({ where: { id: job.id }, data: { status: "BUILDING", attempt: PACKAGE_JOB_MAX_ATTEMPTS, heartbeatAt: null } });
    expect(await jobs.recoverStaleJobs(prisma, { ignoreHeartbeat: true })).toEqual({ requeued: 0, failed: 1 });
    const dead = await prisma.analysisPackageJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(dead).toMatchObject({ status: "FAILED", errorCode: "JOB_ABANDONED" });
    // a human can retry it, and it then completes
    expect((await jobs.enqueuePackageJob(prisma, run.id, "RETRY")).ok).toBe(true);
    expect((await jobs.processNextPackageJob(prisma, { build: fakeBuild() }))!.status).toBe("READY");
  });

  it("REBUILD creates a new package VERSION; older versions and their hashes are preserved and stay downloadable", async () => {
    const run = await prisma.analysisRun.findFirstOrThrow({ where: { scope: "KR" } });
    const v1 = await prisma.analysisPackage.findFirstOrThrow({ where: { analysisRunId: run.id, packageVersion: 1 } });
    const r = await jobs.enqueuePackageJob(prisma, run.id, "REBUILD");
    expect(r.ok && r.reason).toBe("CREATED");
    expect((await jobs.processNextPackageJob(prisma, { build: fakeBuild() }))!.status).toBe("READY");
    const all = await prisma.analysisPackage.findMany({ where: { analysisRunId: run.id }, orderBy: { packageVersion: "asc" } });
    expect(all.map((p) => p.packageVersion)).toEqual([1, 2]);
    expect(all[0].sha256).toBe(v1.sha256); // version 1 untouched
    expect(all[1].sha256).not.toBe(v1.sha256);
    const current = await download(run.id);
    expect(current.headers.get("X-Package-Version")).toBe("2");
    const old = await download(run.id, 1);
    expect(sha256Hex(new Uint8Array(await old.arrayBuffer()))).toBe(v1.sha256);
    expect((await download(run.id, 9)).status).toBe(404);
    expect((await download(run.id, 0)).status).toBe(400);
    const o = await overview();
    expect(o.scopes.KR.packageVersions.map((p: { version: number }) => p.version)).toEqual([2, 1]);
    // versions are capped so the small volume cannot be filled by repeated clicks
    for (let v = 3; v <= MAX_PACKAGE_VERSIONS_PER_RUN; v++) {
      expect((await jobs.enqueuePackageJob(prisma, run.id, "REBUILD")).ok).toBe(true);
      expect((await jobs.processNextPackageJob(prisma, { build: fakeBuild() }))!.status).toBe("READY");
    }
    const over = await jobs.enqueuePackageJob(prisma, run.id, "REBUILD");
    expect(over).toMatchObject({ ok: false, errorCode: "TOO_MANY_VERSIONS" });
  });

  it("a package whose wording version is not the current one is refused by the pipeline", async () => {
    const run = await prisma.analysisRun.findFirstOrThrow({ where: { scope: "JP" } });
    await jobs.enqueuePackageJob(prisma, run.id, "REBUILD");
    const j = await jobs.processNextPackageJob(prisma, { build: fakeBuild({ text: "interpretation-1" }) });
    expect(j).toMatchObject({ status: "FAILED", errorCode: "VERIFY_FAILED" });
    expect(await prisma.analysisPackage.count({ where: { analysisRunId: run.id } })).toBe(1); // nothing registered
    await jobs.enqueuePackageJob(prisma, run.id, "RETRY");
    expect((await jobs.processNextPackageJob(prisma, { build: fakeBuild() }))!.status).toBe("READY");
  });

  it("an old run's ZIP is never offered as the ZIP of a newer result", async () => {
    const oldRun = await prisma.analysisRun.findFirstOrThrow({ where: { scope: "ALL" }, orderBy: { startedAt: "desc" } });
    const newRun = await analyse("ALL"); // a second, newer ALL analysis (same data)
    expect(newRun.id).not.toBe(oldRun.id);
    const o = await overview();
    expect(o.scopes.ALL.official.id).toBe(newRun.id);
    expect(o.scopes.ALL.package).toBeNull(); // the displayed result has no package yet ...
    expect(o.scopes.ALL.packageJob.status).toBe("QUEUED");
    expect(o.scopes.ALL.previousResults).toHaveLength(1); // ... and the older package is listed separately, labelled with ITS run id
    expect(o.scopes.ALL.previousResults[0]).toMatchObject({ runId: oldRun.id });
    expect(o.scopes.ALL.previousResults[0].packages[0].version).toBe(1);
    expect((await download(newRun.id)).status).toBe(404); // the new run id cannot fetch the old run's file
    expect((await download(oldRun.id)).status).toBe(200);
    expect((await jobs.processNextPackageJob(prisma, { build: fakeBuild() }))!.status).toBe("READY");
    const after = await overview();
    expect(after.scopes.ALL.package.version).toBe(1);
    // the package of the new run really belongs to the new run
    const pk = await prisma.analysisPackage.findFirstOrThrow({ where: { analysisRunId: newRun.id } });
    expect(JSON.parse(pk.manifest).runId).toBe(newRun.id);
  });

  it("the manual PUT also adds a version instead of replacing, and registering identical bytes twice is a no-op", async () => {
    const run = await analyse("JP");
    const bytes = buildPackageZip(run, { extraManifest: { packageVersion: 1, packageFormatVersion: PACKAGE_FORMAT_VERSION, interpretationTextVersion: INTERPRETATION_TEXT_VERSION } });
    const put = (b: Uint8Array) => packageRoute.PUT(req("/", { method: "PUT", body: Buffer.from(b), headers: { "x-package-sha256": sha256Hex(b) } }), ctx({ runId: run.id }));
    const first = await (await put(bytes)).json();
    expect(first).toMatchObject({ ok: true, created: true, version: 1 });
    const again = await (await put(bytes)).json();
    expect(again).toMatchObject({ ok: true, created: false, version: 1 });
    expect(await prisma.analysisPackage.count({ where: { analysisRunId: run.id } })).toBe(1);
    const second = buildPackageZip(run, { extraManifest: { packageVersion: 2 }, zipFilename: "JP_second.zip" });
    expect(await (await put(second)).json()).toMatchObject({ created: true, version: 2 });
    expect(await prisma.analysisPackage.count({ where: { analysisRunId: run.id } })).toBe(2);
    // a REBUILD whose bytes equal an already registered version creates no row and says so instead of an unqualified READY
    const enq = await jobs.enqueuePackageJob(prisma, run.id, "REBUILD");
    expect(enq.ok).toBe(true);
    const same = (async () => ({ bytes, filename: "x.zip" })) as unknown as typeof import("@/lib/analysis/packageBuild").buildPackageBytes;
    const job = (await jobs.processNextPackageJob(prisma, { build: same }))!;
    expect(job).toMatchObject({ status: "READY", errorCode: "PACKAGE_UNCHANGED" });
    expect(job.errorMessageSafe).toContain("버전 1");
    expect(await prisma.analysisPackage.count({ where: { analysisRunId: run.id } })).toBe(2);
  });

  it("a registered package whose file is missing or damaged is shown as such and never offered as ready; the analysis stays untouched", async () => {
    const run = await prisma.analysisRun.findFirstOrThrow({ where: { scope: "KR" } });
    const row = await prisma.analysisPackage.findFirstOrThrow({ where: { analysisRunId: run.id, packageVersion: 1 } });
    const file = path.join(path.dirname(dbFile), "analysis-packages", row.storedFile);
    const original = fs.readFileSync(file);
    try {
      fs.chmodSync(file, 0o666);
      fs.rmSync(file);
      let o = await overview();
      const v1 = o.scopes.KR.packageVersions.find((v: { version: number }) => v.version === 1);
      expect(v1.fileStatus).toBe("MISSING");
      const res = await download(run.id, 1);
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ errorCode: "PACKAGE_FILE_MISSING", version: 1 });
      const pj = await (await jobRoute.GET(req("/"), ctx({ runId: run.id }))).json();
      expect(pj.packages.find((p: { packageVersion: number }) => p.packageVersion === 1).fileStatus).toBe("MISSING");
      // same size is not enough: a different content under the same name is caught by the hash on download
      fs.writeFileSync(file, Buffer.alloc(original.length, 1));
      o = await overview();
      expect(o.scopes.KR.packageVersions.find((v: { version: number }) => v.version === 1).fileStatus).toBe("OK"); // cheap check only looks at existence and size
      const bad = await download(run.id, 1);
      expect(bad.status).toBe(500);
      expect((await bad.json()).errorCode).toBe("PACKAGE_INTEGRITY_FAILURE");
      fs.writeFileSync(file, original.subarray(0, 10));
      o = await overview();
      expect(o.scopes.KR.packageVersions.find((v: { version: number }) => v.version === 1).fileStatus).toBe("SIZE_MISMATCH");
      expect((await prisma.analysisRun.findUniqueOrThrow({ where: { id: run.id } })).executionStatus).toBe("COMPLETED");
    } finally {
      fs.rmSync(file, { force: true });
      fs.writeFileSync(file, original);
      fs.chmodSync(file, 0o444);
    }
    expect((await download(run.id, 1)).status).toBe(200);
  });

  it("the stored input is reproduced exactly for the package; if the responses changed, the build stops instead of mixing data", async () => {
    const run = await prisma.analysisRun.findFirstOrThrow({ where: { scope: "KR" } });
    const raw = await loadPackageRaw(prisma, run);
    const snap = JSON.parse(run.inputSnapshot);
    expect(raw.participants).toEqual(snap.participants);
    expect(Object.keys(raw.extras).sort()).toEqual(snap.participants.map((p: { pid: string }) => p.pid).sort());
    for (const p of snap.participants as { pid: string; assignment: number[] }[]) expect(raw.extras[p.pid].pileLabels).toHaveLength(new Set(p.assignment).size);
    const text = JSON.stringify(raw);
    expect(text).not.toContain(REAL_NAME);
    expect(text).not.toContain(REAL_PHONE);
    for (const s of await prisma.sortSession.findMany({ select: { id: true } })) expect(text).not.toContain(s.id);
    // change one response (move an item into another pile) -> the data no longer reproduces the snapshot
    const item = await prisma.sortGroupItem.findFirstOrThrow({ where: { group: { sortSession: { countryCode: "KR" } } }, include: { group: true } });
    const other = await prisma.sortGroup.findFirstOrThrow({ where: { sortSessionId: item.group.sortSessionId, id: { not: item.groupId } } });
    await prisma.sortGroupItem.update({ where: { id: item.id }, data: { groupId: other.id } });
    await expect(loadPackageRaw(prisma, run)).rejects.toBeInstanceOf(PackageInputChangedError);
    // the run is stale now: no new job and a queued job is refused
    expect(await jobs.enqueuePackageJob(prisma, run.id, "REBUILD")).toMatchObject({ ok: false, errorCode: "RESULT_NOT_CURRENT" });
    await prisma.sortGroupItem.update({ where: { id: item.id }, data: { groupId: item.groupId } });
    await expect(loadPackageRaw(prisma, run)).resolves.toBeTruthy();
  });

  it("the bundle shown for an old run uses the CURRENT interpretation wording while every number stays as stored", async () => {
    const run = await prisma.analysisRun.findFirstOrThrow({ where: { scope: "KR" } });
    const stored = JSON.parse(run.resultBundle!);
    // make it look like a first-release bundle: old wording, no interpretation block
    stored.metrics = stored.metrics.filter((m: { id: string }) => m.id !== "fit_interpretation");
    const s1 = stored.metrics.find((m: { id: string }) => m.id === "stress1");
    s1.verdicts = [{ aspectKo: "일반 MDS 참고 구분", textKo: "Kruskal 구술 척도의 가장 낮은 구간(poor, 0.20)보다 큼. 이는 불리한 결과이며 숨기지 않음", tone: "unfavorable" }];
    delete stored.interpretation;
    await prisma.analysisRun.update({ where: { id: run.id }, data: { resultBundle: JSON.stringify(stored) } });
    const res = await (await bundleRoute.GET(req("/"), ctx({ runId: run.id }))).json();
    const b = res.bundle;
    expect(b.interpretation).toEqual({ textVersion: INTERPRETATION_TEXT_VERSION, storedTextVersion: "interpretation-1" });
    const metrics = b.metrics as { id: string; evaluates?: string; verdicts: { tone: string; textKo: string }[]; nameKo: string }[];
    expect(metrics.some((m) => m.id === "fit_interpretation" && m.nameKo === "2차원 표현의 적합도 해석")).toBe(true);
    const stress = metrics.find((m) => m.id === "stress1")!;
    expect(JSON.stringify(stress.verdicts)).not.toContain("불리");
    expect(stress.verdicts.every((v) => v.tone !== "unfavorable")).toBe(true);
    expect(stress.evaluates).toBe("2차원 표현의 적합도");
    expect(JSON.stringify(stress)).not.toContain("0.205"); // the first release's second-hand range is no longer presented as the comparison range
    expect(JSON.stringify(stress)).toContain("0.17");
    // numbers untouched
    expect(b.analysis).toEqual(stored.analysis);
    expect(b.meta).toEqual(stored.meta);
  });
});
