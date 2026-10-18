import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { zipSync, strToU8 } from "fflate";

const dbFile = path.join(os.tmpdir(), `concept-sort-cmpipe-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
const MIGRATIONS_DIR = path.resolve(process.cwd(), "prisma/migrations");
{
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA foreign_keys = ON;");
  const names = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((n) => /^\d{14}_/.test(n))
    .sort();
  for (const name of names) db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf-8"));
  db.close();
}
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.ANALYSIS_ENGINE_SOURCE_COMMIT_SHA = "c".repeat(40);

const { prisma } = await import("@/lib/db");
const bundleRoute = await import("@/app/api/projects/[slug]/analysis/runs/[runId]/bundle/route");
const packageRoute = await import("@/app/api/projects/[slug]/analysis/runs/[runId]/package/route");
const cleanupRoute = await import("@/app/api/projects/[slug]/analysis/cleanup-superseded/route");
const overviewRoute = await import("@/app/api/projects/[slug]/analysis/overview/route");
const { createAnalysisRun, executeAnalysisRun } = await import("@/lib/analysis/executionService");
const { DEFAULT_ANALYSIS_PARAMETERS, VALIDATION_BASELINE_SHA } = await import("@/lib/analysis/config");
const { evaluateConfiguration } = await import("@/lib/conceptAnalysis/smacofV2");

const SLUG = "cmpipe";
const TOKEN = `token-${SLUG}`;
const N_ST = 12;
const REAL_NAME = "REAL-NAME-SHOULD-NEVER-LEAK";
const REAL_PHONE = "010-9999-8888";

const req = (url: string, init?: RequestInit) => new NextRequest(`http://localhost${url}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) } } as never);
const ctx = (extra: Record<string, string> = {}) => ({ params: Promise.resolve({ slug: SLUG, ...extra }) });
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

async function tableHash(table: string): Promise<string> {
  const rows = (await prisma.$queryRawUnsafe(`select * from "${table}" order by id`)) as Record<string, unknown>[];
  return sha(JSON.stringify(rows, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}
const RAW_TABLES = ["Project", "Statement", "SortSession", "SortGroup", "SortGroupItem"];
async function rawHashes() {
  return Object.fromEntries(await Promise.all(RAW_TABLES.map(async (t) => [t, await tableHash(t)])));
}

let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

async function seedData() {
  const project = await prisma.project.create({ data: { slug: SLUG, adminToken: TOKEN, title: "t", prompt: "p", consentKo: "c", koPreviewConfirmedAt: new Date(), titleJa: "t", promptJa: "p", consentJa: "c", jaPreviewConfirmedAt: new Date() } });
  const statements = [];
  for (let i = 0; i < N_ST; i++) statements.push(await prisma.statement.create({ data: { projectId: project.id, text: `문항 ${i}`, textJa: `項目 ${i}`, jaStatus: "APPROVED", order: i } }));
  const ids = statements.map((s) => s.id);
  const make = async (country: "KR" | "JP", role: "MAIN" | "PILOT") => {
    // three themes of four statements with 15 % random moves
    const pile = ids.map((_, s) => (rnd() < 0.15 ? Math.floor(rnd() * 3) : Math.floor(s / 4)));
    const groups = [0, 1, 2].map((g) => ids.filter((_, s) => pile[s] === g)).filter((g) => g.length > 0);
    await prisma.sortSession.create({
      data: {
        projectId: project.id,
        participantName: REAL_NAME,
        gender: "x",
        age: 20,
        schoolLevel: "x",
        grade: "x",
        phoneNumber: REAL_PHONE,
        countryCode: country,
        dataRole: role,
        groups: { create: groups.map((g) => ({ label: "그룹", items: { create: g.map((statementId) => ({ statementId })) } })) },
      },
    });
  };
  for (let i = 0; i < 7; i++) await make("KR", "MAIN");
  for (let i = 0; i < 9; i++) await make("JP", "MAIN");
  await make("KR", "PILOT");
  return { project, ids };
}

const { project } = await seedData();

// Same code path as the route (createAnalysisRun -> executeAnalysisRun) with a lighter budget so the suite stays fast;
// the production defaults (64 starts x 10,000 iterations x 5 dimensions) are exercised on the real data separately.
const LIGHT = { ...DEFAULT_ANALYSIS_PARAMETERS, dimensionsEvaluated: [1, 2, 3], nInit: 8, maxIter: 3000, strictMaxIter: 6000, splitHalfRepetitions: 100 };

async function post(scope: string) {
  const { runId } = await createAnalysisRun({ prisma, projectId: project.id, scope: scope as "KR" | "JP" | "ALL", dataset: "MAIN", analysisParameters: LIGHT, validationBaselineSha: VALIDATION_BASELINE_SHA, engineSourceCommitSha: "c".repeat(40) });
  await executeAnalysisRun(prisma, runId);
  const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
  return { status: 201, body: { id: run.id, executionStatus: run.executionStatus, includedParticipantCount: run.includedParticipantCount } };
}

describe("v2 analysis pipeline — end to end on a disposable DB", () => {
  it("runs each scope on MAIN data only, stores a result bundle and never touches raw data", async () => {
    const before = await rawHashes();
    const out: Record<string, { status: number; body: { id: string; executionStatus: string; includedParticipantCount: number } }> = {};
    for (const scope of ["KR", "JP", "ALL"]) out[scope] = await post(scope);
    expect(out.KR.status).toBe(201);
    expect(out.KR.body.executionStatus).toBe("COMPLETED");
    expect(out.KR.body.includedParticipantCount).toBe(7);
    expect(out.JP.body.includedParticipantCount).toBe(9);
    expect(out.ALL.body.includedParticipantCount).toBe(16);
    expect(await rawHashes()).toEqual(before); // row- and column-level identity of every raw table

    const ids = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.body.id]));
    const res = await bundleRoute.GET(req(`/api/projects/${SLUG}/analysis/runs/${ids.ALL}/bundle`), ctx({ runId: ids.ALL }));
    const j = await res.json();
    expect(j.officialResult).toBe(true);
    const b = j.bundle;
    expect(b.meta.algorithmVersion).toBe("2.0.0");
    expect(b.meta.N).toBe(16);
    expect(b.analysis.matrixChecks.symmetric).toBe(true);
    expect(b.analysis.solutions.length).toBeGreaterThan(0);
    expect(b.metrics.map((m: { id: string }) => m.id)).toContain("stress1");
    expect(b.analysis.splitHalf.halfSizes).toEqual({ KR: [3, 4], JP: [4, 5] });
    expect(b.comparison.nKr).toBe(7);

    // ALL = KR + JP at the level of the stored count matrices
    const kr = (await (await bundleRoute.GET(req(""), ctx({ runId: ids.KR }))).json()).bundle;
    const jp = (await (await bundleRoute.GET(req(""), ctx({ runId: ids.JP }))).json()).bundle;
    for (let i = 0; i < N_ST; i++) for (let jx = 0; jx < N_ST; jx++) expect(b.analysis.S[i][jx]).toBe(kr.analysis.S[i][jx] + jp.analysis.S[i][jx]);
    expect(kr.meta.fingerprints.participantsHash).not.toBe(jp.meta.fingerprints.participantsHash);
  });

  it("the stored snapshot is pseudonymous: no name, phone or session id, pile membership preserved", async () => {
    const run = await prisma.analysisRun.findFirstOrThrow({ where: { scope: "ALL" } });
    expect(run.inputSnapshot).not.toContain(REAL_NAME);
    expect(run.inputSnapshot).not.toContain(REAL_PHONE);
    const sessionIds = (await prisma.sortSession.findMany({ select: { id: true } })).map((s) => s.id);
    for (const id of sessionIds) expect(run.inputSnapshot).not.toContain(id);
    expect(run.resultBundle).not.toContain(REAL_NAME);
    const snap = JSON.parse(run.inputSnapshot);
    expect(snap.participants.map((p: { pid: string }) => p.pid).slice(0, 2)).toEqual(["KR-001", "KR-002"]);
    expect(snap.participants.length).toBe(16);
    // membership: statements sharing a pile in the DB share an index in the snapshot
    const sess = await prisma.sortSession.findMany({ where: { dataRole: "MAIN", countryCode: "KR" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: { groups: { include: { items: true } } } });
    const first = sess[0];
    const orderOf = new Map((await prisma.statement.findMany()).map((s) => [s.id, s.order]));
    for (const g of first.groups) {
      const idx = g.items.map((i) => snap.participants[0].assignment[orderOf.get(i.statementId)!]);
      expect(new Set(idx).size).toBe(1);
    }
  });

  it("every dimension row carries its explicit termination reasons and metrics recomputed from its own coordinates match", async () => {
    const run = await prisma.analysisRun.findFirstOrThrow({ where: { scope: "ALL" }, include: { dimensions: true } });
    const snap = JSON.parse(run.inputSnapshot);
    expect(run.dimensions.map((d) => d.dimension).sort()).toEqual([1, 2, 3]);
    for (const d of run.dimensions) {
      const meta = JSON.parse(d.normalizationMeta!);
      expect(["CONVERGED", "MAX_ITER", "OBJECTIVE_INCREASED"]).toContain(meta.mainRun.reason);
      expect(d.converged).toBe(meta.mainRun.reason === "CONVERGED" && meta.strictRun.reason === "CONVERGED");
      const ev = evaluateConfiguration(JSON.parse(d.coordinates!), snap.numeric.dissimilarityMatrix, snap.numeric.weightMatrix);
      expect(ev.rawStress).toBeCloseTo(d.rawStress!, 9);
      expect(ev.stress1).toBeCloseTo(d.commonStressDistance!, 9);
      expect(meta.historyKind).toBe("rawStress");
    }
  });

  it("a primary solution that does not converge FAILS the run, keeps the reason and performs no clustering", async () => {
    const params = { ...LIGHT, nInit: 2, maxIter: 2, strictMaxIter: 2, splitHalfRepetitions: 5 };
    const { runId } = await createAnalysisRun({ prisma, projectId: project.id, scope: "JP", dataset: "MAIN", analysisParameters: params, validationBaselineSha: VALIDATION_BASELINE_SHA, engineSourceCommitSha: "d".repeat(40) });
    await executeAnalysisRun(prisma, runId);
    const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.executionStatus).toBe("FAILED");
    expect(run.errorCode).toBe("MDS_NOT_CONVERGED");
    expect(run.wardStatus).toBe("NOT_RUN");
    expect(run.wardLinkageSnapshot).toBeNull();
    const bundle = JSON.parse(run.resultBundle!);
    expect(bundle.analysis.solutions).toEqual([]);
    expect(bundle.analysis.pairDiagnostics).toBeNull();
    expect(bundle.analysis.primary.numericallyConverged).toBe(false);
    expect(bundle.analysis.primary.terminationReasonTally).toEqual({ MAX_ITER: 2 });
    expect(await prisma.analysisExecutionLock.count()).toBe(0);
  });
});

describe("package upload / download and superseded-result cleanup", () => {
  async function official(scope: string) {
    return prisma.analysisRun.findFirstOrThrow({ where: { scope, executionStatus: "COMPLETED", algorithmVersion: "2.0.0" }, orderBy: { startedAt: "desc" } });
  }
  function buildZip(run: { id: string; scope: string; resultBundle: string | null }, mutate?: (m: Record<string, unknown>, files: Record<string, Uint8Array>) => void) {
    const f = JSON.parse(run.resultBundle!).meta.fingerprints;
    const files: Record<string, Uint8Array> = { "pkg/README.txt": strToU8("hello"), "pkg/data.csv": strToU8("a,b\n1,2\n") };
    const manifest: Record<string, unknown> = {
      manifestVersion: 1,
      runId: run.id,
      scope: run.scope,
      zipFilename: `${run.scope}_분석자료.zip`,
      fingerprints: { participantsHash: f.participantsHash, numericDataHash: f.numericDataHash, parameterHash: f.parameterHash },
      files: Object.entries(files).map(([p, b]) => ({ path: p.replace(/^pkg\//, ""), sha256: sha(b), bytes: b.byteLength })),
    };
    mutate?.(manifest, files);
    const all: Record<string, Uint8Array> = { ...files, "pkg/manifest.json": strToU8(JSON.stringify(manifest)) };
    return zipSync(all);
  }
  const put = async (runId: string, bytes: Uint8Array, hash = sha(bytes)) =>
    packageRoute.PUT(req(`/api/projects/${SLUG}/analysis/runs/${runId}/package`, { method: "PUT", body: bytes as never, headers: { "x-package-sha256": hash } }), ctx({ runId }));

  it("rejects a package whose manifest does not match the run, its fingerprints, its files or its own hash", async () => {
    const run = await official("KR");
    const other = await official("JP");
    expect((await put(run.id, buildZip(run), "0".repeat(64))).status).toBe(422);
    expect((await (await put(run.id, buildZip(other))).json()).errorCode).toBe("MANIFEST_RUN_MISMATCH");
    const badFp = buildZip(run, (m) => ((m.fingerprints as Record<string, string>).participantsHash = "x"));
    expect((await (await put(run.id, badFp)).json()).errorCode).toBe("MANIFEST_FINGERPRINT_MISMATCH");
    const badFile = buildZip(run, (m) => ((m.files as { sha256: string }[])[0].sha256 = "0".repeat(64)));
    expect((await (await put(run.id, badFile)).json()).errorCode).toBe("MANIFEST_FILE_HASH_MISMATCH");
    const extra = buildZip(run, (_m, files) => (files["pkg/extra.txt"] = strToU8("sneaky")));
    expect((await (await put(run.id, extra)).json()).errorCode).toBe("UNLISTED_FILES_PRESENT");
    const badName = buildZip(run, (m) => (m.zipFilename = "../evil.zip"));
    expect((await (await put(run.id, badName)).json()).errorCode).toBe("ZIP_FILENAME_INVALID");
    expect(await prisma.analysisPackage.count()).toBe(0);
  });

  it("stores a valid package and serves back exactly the same bytes; requires admin", async () => {
    const run = await official("KR");
    const zip = buildZip(run);
    const ok = await put(run.id, zip);
    expect(ok.status).toBe(200);
    const res = await packageRoute.GET(req(`/api/projects/${SLUG}/analysis/runs/${run.id}/package`), ctx({ runId: run.id }));
    expect(res.status).toBe(200);
    expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(sha(zip));
    expect(decodeURIComponent(res.headers.get("Content-Disposition")!)).toContain(`${run.scope}_분석자료.zip`);
    const anon = await packageRoute.GET(new NextRequest(`http://localhost/x`), ctx({ runId: run.id }));
    expect(anon.status).toBe(401);
    const ov = await (await overviewRoute.GET(req(`/api/projects/${SLUG}/analysis/overview`), ctx())).json();
    expect(ov.scopes.KR.package.filename).toContain("KR_");
    expect(ov.scopes.JP.package).toBeNull();
  });

  it("cleanup refuses without a current packaged result for every scope, then deletes ONLY superseded derived rows", async () => {
    // a superseded (v1) run with children
    const legacy = await prisma.analysisRun.create({
      data: {
        projectId: project.id, scope: "ALL", dataset: "MAIN", executionStatus: "COMPLETED", numericDataHash: "n", statementStructureHash: "s", statementContentHashKo: "k", statementContentHashJa: "j", parameterHash: "p", sourceSnapshotAt: new Date(), inputSnapshot: "{}", parametersSnapshot: "{}",
        algorithmVersion: "1.0.0", engineSourceCommitSha: "e".repeat(40), primaryMapDimension: 2, wardSourceDimension: 2, linkageMethod: "ward", dimensionsEvaluated: "[2]", include3dSupplement: false,
        statementCount: N_ST, nKr: 1, nJp: 1, nTotal: 2, includedParticipantCount: 2, excludedNullCountry: 0, excludedIncomplete: 0, excludedInvalid: 0, wardStatus: "COMPLETED",
        dimensions: { create: [{ dimension: 2, dimensionStatus: "COMPLETED", converged: false }] },
        interpretations: { create: [{ status: "DRAFT", version: 1, selectedClusterCount: 3 }] },
      },
    });
    const post0 = (body: unknown) => cleanupRoute.POST(req(`/api/projects/${SLUG}/analysis/cleanup-superseded`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), ctx());
    expect((await post0({})).status).toBe(422); // confirmation required
    const confirm = { confirm: "DELETE_SUPERSEDED_DERIVED_RESULTS" };
    expect((await post0(confirm)).status).toBe(409); // JP/ALL have no package yet
    for (const scope of ["JP", "ALL"]) {
      const run = await official(scope);
      expect((await put(run.id, buildZip(run))).status).toBe(200);
    }
    const rawBefore = await rawHashes();
    const counts = { sessions: await prisma.sortSession.count(), groups: await prisma.sortGroup.count(), items: await prisma.sortGroupItem.count() };
    const res = await post0(confirm);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.deleted.map((d: { id: string }) => d.id)).toEqual([legacy.id]);
    expect(await prisma.analysisRun.findUnique({ where: { id: legacy.id } })).toBeNull();
    expect(await prisma.analysisRunDimension.count({ where: { analysisRunId: legacy.id } })).toBe(0);
    expect(await prisma.analysisInterpretation.count({ where: { analysisRunId: legacy.id } })).toBe(0);
    // current-version runs and their packages survive; raw data identical row by row
    expect(await prisma.analysisPackage.count()).toBe(3);
    expect(await rawHashes()).toEqual(rawBefore);
    expect({ sessions: await prisma.sortSession.count(), groups: await prisma.sortGroup.count(), items: await prisma.sortGroupItem.count() }).toEqual(counts);
  });
});
