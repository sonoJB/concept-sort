import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { zipSync, strToU8 } from "fflate";
import { buildPackageZip, responseCsvFor, participantFilesFor } from "./testSupport/packageFixture";

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
const DIGIT_NAME = "7391";
const RESPONSE_PATH_FOR_TEST = "02_원자료_가명/참여자별_분류응답표.csv";

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
  const make = async (country: "KR" | "JP", role: "MAIN" | "PILOT", name = REAL_NAME) => {
    // three themes of four statements with 15 % random moves
    const pile = ids.map((_, s) => (rnd() < 0.15 ? Math.floor(rnd() * 3) : Math.floor(s / 4)));
    const groups = [0, 1, 2].map((g) => ids.filter((_, s) => pile[s] === g)).filter((g) => g.length > 0);
    await prisma.sortSession.create({
      data: {
        projectId: project.id,
        participantName: name,
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
  await make("KR", "PILOT", DIGIT_NAME); // a digit-only identifier (like the JP 4-digit codes)
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
  function buildZip(run: { id: string; scope: string; inputSnapshot: string; resultBundle: string | null }, mutate?: (m: Record<string, unknown>, files: Record<string, Uint8Array>) => void) {
    return buildPackageZip(run, { files: { "pkg/data.csv": strToU8("a,b\n1,2\n") }, mutate });
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

  it("rejects an upload that contains personal data (name, phone, real session id, admin token) without echoing it", async () => {
    const run = await official("JP");
    const sess = await prisma.sortSession.findFirstOrThrow();
    for (const [label, secret] of [["name", REAL_NAME], ["phone", REAL_PHONE], ["sessionId", sess.id], ["adminToken", TOKEN]] as const) {
      const res = await put(run.id, buildPackageZip(run, { files: { "pkg/data.csv": strToU8(`a,b\n${secret},2\n`) } }));
      const j = await res.json();
      expect(res.status, label).toBe(422);
      expect(j.errorCode).toBe("PACKAGE_CONTAINS_PERSONAL_DATA");
      expect(JSON.stringify(j)).not.toContain(secret);
    }
    // e-mail addresses and Japanese-style phone numbers typed as free text are rejected too
    for (const free of ["write me: someone@example.com", "call 090-1234-5678"]) {
      const res = await put(run.id, buildPackageZip(run, { files: { "pkg/notes.txt": strToU8(free) } }));
      expect(res.status, free).toBe(422);
    }
    expect(await prisma.analysisPackage.count({ where: { analysisRunId: run.id } })).toBe(0);
  });

  it("a package whose response table does not equal the run's stored records is rejected (country separation is enforced by the server)", async () => {
    const run = await official("KR");
    await prisma.analysisPackage.deleteMany({ where: { analysisRunId: run.id } });
    const other = await official("JP");
    // (a) a JP participant smuggled into a KR package
    const jpRows = JSON.parse(other.inputSnapshot).participants.slice(0, 1) as { pid: string; country: string; assignment: number[] }[];
    const withJp = buildPackageZip(run, { files: { [`pkg/${RESPONSE_PATH_FOR_TEST}`]: responseCsvFor(run, (rows) => jpRows[0].assignment.forEach((g, i) => rows.push([jpRows[0].pid, "JP", "2026-01-01 00:00:00", `S${i + 1}`, i + 1, g + 1, ""]))) } });
    let j = await (await put(run.id, withJp)).json();
    expect(j.errorCode).toBe("PACKAGE_RESPONSES_MISMATCH");
    // (b) the whole table replaced by the other country's responses
    const swapped = buildPackageZip(run, { files: { [`pkg/${RESPONSE_PATH_FOR_TEST}`]: responseCsvFor(other) } });
    j = await (await put(run.id, swapped)).json();
    expect(j.errorCode).toBe("PACKAGE_RESPONSES_MISMATCH");
    // (c) one edited assignment
    const edited = buildPackageZip(run, { files: { [`pkg/${RESPONSE_PATH_FOR_TEST}`]: responseCsvFor(run, (rows) => { rows[3][5] = Number(rows[3][5]) + 1; }) } });
    j = await (await put(run.id, edited)).json();
    expect(j.errorCode).toBe("PACKAGE_RESPONSES_MISMATCH");
    // (d) a missing response table
    const missing = buildPackageZip(run, { omitResponses: true });
    j = await (await put(run.id, missing)).json();
    expect(j.errorCode).toBe("PACKAGE_RESPONSES_MISMATCH");
    expect(await prisma.analysisPackage.count({ where: { analysisRunId: run.id } })).toBe(0);
    // (e) a row for a middle statement deleted (same length, sparse hole) and (f) a duplicate row
    const dropMiddle = buildPackageZip(run, { files: { [`pkg/${RESPONSE_PATH_FOR_TEST}`]: responseCsvFor(run, (rows) => { rows.splice(5, 1); }) } });
    j = await (await put(run.id, dropMiddle)).json();
    expect(j.errorCode, "missing middle row").toBe("PACKAGE_RESPONSES_MISMATCH");
    const dup = buildPackageZip(run, { files: { [`pkg/${RESPONSE_PATH_FOR_TEST}`]: responseCsvFor(run, (rows) => { rows.splice(6, 1, [...rows[5]]); }) } });
    j = await (await put(run.id, dup)).json();
    expect(j.errorCode, "duplicate row").toBe("PACKAGE_RESPONSES_MISMATCH");
    // (g) the other participant-level files are compared with the run too
    const jpPid = (JSON.parse(other.inputSnapshot).participants[0] as { pid: string }).pid;
    const variants: [string, Record<string, Uint8Array>][] = [
      ["wide table with a foreign participant", participantFilesFor(run, { wide: (rows) => { rows[1][0] = jpPid; } })],
      ["wide table with a flipped bit", participantFilesFor(run, { wide: (rows) => { rows[1][2] = rows[1][2] === 1 ? 0 : 1; } })],
      ["wide table missing a participant", participantFilesFor(run, { wide: (rows) => { rows.pop(); } })],
      ["summary with a foreign country", participantFilesFor(run, { summary: (rows) => { rows[1][1] = "JP"; } })],
      ["summary missing a participant", participantFilesFor(run, { summary: (rows) => { rows.pop(); } })],
      ["S matrix with an altered cell", participantFilesFor(run, { s: (rows) => { rows[1][2] = Number(rows[1][2]) + 1; } })],
    ];
    for (const [label, files] of variants) {
      j = await (await put(run.id, buildPackageZip(run, { files }))).json();
      expect(j.errorCode, label).toBe("PACKAGE_RESPONSES_MISMATCH");
    }
    // (h) an office file that cannot be opened cannot be shown to be free of personal data
    const unreadable = await put(run.id, buildPackageZip(run, { files: { "pkg/02_원자료_가명/표.xlsx": strToU8("not a zip") } }));
    expect(unreadable.status).toBe(422);
    expect((await unreadable.json()).findings.unreadableOfficeFile).toBe(1);
    expect(await prisma.analysisPackage.count({ where: { analysisRunId: run.id } })).toBe(0);
    // the genuine table is accepted
    expect((await put(run.id, buildZip(run))).status).toBe(200);
    await prisma.analysisPackage.deleteMany({ where: { analysisRunId: run.id } });
  });

  it("unsafe entry names, several root folders and oversized declarations are rejected before anything is inflated or stored", async () => {
    const run = await official("KR");
    const zipRaw = (names: string[]) => zipSync(Object.fromEntries(names.map((n) => [n, strToU8("x")])));
    for (const [label, bytes, code] of [
      ["dot-dot", zipRaw(["pkg/../evil.txt", "pkg/manifest.json"]), "UNSAFE_ENTRY_NAME"],
      ["backslash", zipRaw(["pkg\\evil.txt", "pkg/manifest.json"]), "UNSAFE_ENTRY_NAME"],
      ["absolute", zipRaw(["/abs.txt", "pkg/manifest.json"]), "UNSAFE_ENTRY_NAME"],
      ["two roots", zipRaw(["a/x.txt", "b/manifest.json"]), "EXACTLY_ONE_ROOT_FOLDER_REQUIRED"],
      ["no root", zipRaw(["manifest.json"]), "EXACTLY_ONE_ROOT_FOLDER_REQUIRED"],
    ] as const) {
      const res = await put(run.id, bytes);
      expect(res.status, label).toBe(422);
      expect((await res.json()).errorCode, label).toBe(code);
    }
  });

  it("a package cannot be attached to a stale run (the result would not be downloadable anyway)", async () => {
    const run = await official("JP");
    const sess = await prisma.sortSession.create({ data: { projectId: project.id, participantName: "x-stale", gender: "x", age: 20, schoolLevel: "x", grade: "x", phoneNumber: "000", countryCode: "JP", dataRole: "MAIN", groups: { create: [{ items: { create: JSON.parse(run.inputSnapshot).statements.map((s: { id: string }) => ({ statementId: s.id })) } }] } } });
    const res = await put(run.id, buildZip(run));
    expect(res.status).toBe(409);
    expect((await res.json()).errorCode).toBe("RESULT_NOT_CURRENT");
    await prisma.sortSession.delete({ where: { id: sess.id } });
  });

  it("an unexpected exception during execution marks the run FAILED and releases the lock (the scope is not blocked)", async () => {
    const { runId } = await createAnalysisRun({ prisma, projectId: project.id, scope: "KR", dataset: "MAIN", analysisParameters: LIGHT, validationBaselineSha: VALIDATION_BASELINE_SHA, engineSourceCommitSha: "c".repeat(40) });
    await prisma.analysisRun.update({ where: { id: runId }, data: { inputSnapshot: "{}" } }); // corrupt snapshot -> TypeError inside the engine path
    await executeAnalysisRun(prisma, runId);
    const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.executionStatus).toBe("FAILED");
    expect(run.errorCode).toBe("ANALYSIS_EXCEPTION");
    expect(await prisma.analysisExecutionLock.count({ where: { analysisRunId: runId } })).toBe(0);
    await post("KR"); // a new run for the same scope is possible immediately
  });

  it("digit-only identifiers are rejected inside the participant response folder but ordinary numbers elsewhere are accepted", async () => {
    const run = await official("JP");
    const bad = await put(run.id, buildPackageZip(run, { files: { "pkg/02_원자료_가명/응답.csv": strToU8(`id,label\nJP-001,${DIGIT_NAME}\n`) } }));
    expect(bad.status).toBe(422);
    expect((await bad.json()).findings.digitOnlyIdentifierCell).toBe(1);
    const fine = await put(run.id, buildPackageZip(run, { files: { "pkg/05_MDS/초기화별.csv": strToU8(`iterations\n${DIGIT_NAME}\n`) } }));
    expect(fine.status).toBe(200);
    await prisma.analysisPackage.deleteMany({ where: { analysisRunId: run.id } });
  });

  describe("restricted replacement of erroneous MAIN results", () => {
    const post0 = (body: unknown) => cleanupRoute.POST(req(`/api/projects/${SLUG}/analysis/cleanup-superseded`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), ctx());
    const get0 = async () => (await cleanupRoute.GET(req(`/api/projects/${SLUG}/analysis/cleanup-superseded`), ctx())).json();
    const base = (scope: string, dataset: string, version: string) => ({
      projectId: project.id,
      scope,
      dataset,
      executionStatus: "COMPLETED",
      numericDataHash: "n",
      statementStructureHash: "s",
      statementContentHashKo: "k",
      statementContentHashJa: "j",
      parameterHash: "p",
      sourceSnapshotAt: new Date(),
      inputSnapshot: "{}",
      parametersSnapshot: "{}",
      algorithmVersion: version,
      engineSourceCommitSha: "e".repeat(40),
      primaryMapDimension: 2,
      wardSourceDimension: 2,
      linkageMethod: "ward",
      dimensionsEvaluated: "[2]",
      include3dSupplement: false,
      statementCount: N_ST,
      nKr: 1,
      nJp: 1,
      nTotal: 2,
      includedParticipantCount: 2,
      excludedNullCountry: 0,
      excludedIncomplete: 0,
      excludedInvalid: 0,
      wardStatus: "COMPLETED",
      dimensions: { create: [{ dimension: 2, dimensionStatus: "COMPLETED", converged: false }] },
      interpretations: { create: [{ status: "DRAFT", version: 1, selectedClusterCount: 3 }] },
    });
    const ids: Record<string, string> = {};
    let confirm = { confirm: "DELETE_SUPERSEDED_DERIVED_RESULTS", algorithmVersions: ["1.0.0"] as string[] | undefined, runIds: [] as string[] };

    it("dry run lists ONLY erroneous-version MAIN KR/JP/ALL runs; pilot, check-up, legacy, other-version and current runs are not eligible", async () => {
      ids.mainAll = (await prisma.analysisRun.create({ data: base("ALL", "MAIN", "1.0.0") })).id;
      ids.mainKr = (await prisma.analysisRun.create({ data: base("KR", "MAIN", "1.0.0") })).id;
      ids.pilot = (await prisma.analysisRun.create({ data: base("ALL", "PILOT", "1.0.0") })).id;
      ids.checkup = (await prisma.analysisRun.create({ data: base("ALL", "ALL_WITH_PILOT", "1.0.0") })).id;
      ids.legacy = (await prisma.analysisRun.create({ data: base("KR", "LEGACY_PRE_SEGREGATION", "1.0.0") })).id;
      ids.otherVersion = (await prisma.analysisRun.create({ data: base("JP", "MAIN", "1.5.0") })).id;
      const j = await get0();
      expect(j.dryRun).toBe(true);
      expect(j.targets.map((t: { id: string }) => t.id).sort()).toEqual([ids.mainAll, ids.mainKr].sort());
      expect(j.targets.every((t: { dataset: string; algorithmVersion: string }) => t.dataset === "MAIN" && t.algorithmVersion === "1.0.0")).toBe(true);
      expect(j.targetCount).toBe(2);
      expect(j.preconditions.ok).toBe(false); // JP / ALL have no packaged result yet
      confirm = { confirm: "DELETE_SUPERSEDED_DERIVED_RESULTS", algorithmVersions: ["1.0.0"], runIds: j.targets.map((t: { id: string }) => t.id) };
    });

    it("refuses without confirmation, without the explicit version, with a wrong run id list, and while preconditions fail — deleting nothing", async () => {
      const before = await prisma.analysisRun.count();
      expect((await post0({})).status).toBe(422);
      expect((await post0({ ...confirm, algorithmVersions: ["2.0.0"] })).status).toBe(422);
      expect((await post0({ ...confirm, algorithmVersions: undefined })).status).toBe(422);
      const wrong = await post0({ ...confirm, runIds: [confirm.runIds[0]] });
      expect(wrong.status).toBe(409);
      expect((await wrong.json()).errorCode).toBe("RUN_IDS_DO_NOT_MATCH_ELIGIBLE_TARGETS");
      const pre = await post0(confirm);
      expect(pre.status).toBe(409);
      expect((await pre.json()).errorCode).toBe("PRECONDITIONS_NOT_MET");
      expect(await prisma.analysisRun.count()).toBe(before);
    });

    it("checks the package file on disk (existence, SHA-256, manifest) and cross-scope consistency before allowing deletion", async () => {
      for (const scope of ["KR", "JP", "ALL"]) {
        const run = await official(scope);
        expect((await put(run.id, buildZip(run))).status).toBe(200);
      }
      const dry = await get0();
      expect(dry.preconditions.problems).toEqual([]);
      // 1) package file corrupted on disk (same name, different bytes)
      const pkg = await prisma.analysisPackage.findFirstOrThrow({ where: { scope: "KR" } });
      const { packageStorageDir } = await import("@/lib/analysis/packageStore");
      const file = path.join(packageStorageDir(), pkg.storedFile);
      const original = fs.readFileSync(file);
      fs.chmodSync(file, 0o666); // the store makes files read-only; the test simulates damage by an operator
      fs.writeFileSync(file, Buffer.from("corrupted"));
      let pre = await (await post0(confirm)).json();
      expect(pre.errorCode).toBe("PRECONDITIONS_NOT_MET");
      expect(JSON.stringify(pre.preconditions.problems)).toContain("SHA-256 mismatch");
      // 2) package file missing
      fs.rmSync(file);
      pre = await (await post0(confirm)).json();
      expect(JSON.stringify(pre.preconditions.problems)).toContain("KR: package file missing");
      fs.writeFileSync(file, original);
      // 3) ALL no longer equals KR + JP
      const all = await official("ALL");
      const bundle = JSON.parse(all.resultBundle!);
      bundle.analysis.S[0][1] += 1;
      await prisma.analysisRun.update({ where: { id: all.id }, data: { resultBundle: JSON.stringify(bundle) } });
      pre = await (await post0(confirm)).json();
      expect(JSON.stringify(pre.preconditions.problems)).toContain("S(ALL) != S(KR) + S(JP)");
      bundle.analysis.S[0][1] -= 1;
      await prisma.analysisRun.update({ where: { id: all.id }, data: { resultBundle: JSON.stringify(bundle) } });
      // 4) a non-converged current result
      const jp = await official("JP");
      const jb = JSON.parse(jp.resultBundle!);
      jb.analysis.primary.numericallyConverged = false;
      await prisma.analysisRun.update({ where: { id: jp.id }, data: { resultBundle: JSON.stringify(jb) } });
      pre = await (await post0(confirm)).json();
      expect(JSON.stringify(pre.preconditions.problems)).toContain("JP: primary 2D solution did not converge");
      jb.analysis.primary.numericallyConverged = true;
      await prisma.analysisRun.update({ where: { id: jp.id }, data: { resultBundle: JSON.stringify(jb) } });
      expect((await get0()).preconditions.ok).toBe(true);
    });

    it("deletes exactly the listed erroneous MAIN runs and their children; everything else — including raw data row by row — is untouched", async () => {
      const rawBefore = await rawHashes();
      const counts = { sessions: await prisma.sortSession.count(), groups: await prisma.sortGroup.count(), items: await prisma.sortGroupItem.count() };
      const keep = [ids.pilot, ids.checkup, ids.legacy, ids.otherVersion];
      const currentBefore = await prisma.analysisRun.findMany({ where: { algorithmVersion: "2.0.0" }, select: { id: true } });
      const packagesBefore = await prisma.analysisPackage.count();
      const res = await post0(confirm);
      expect(res.status).toBe(200);
      const j = await res.json();
      expect(j.deletedRuns).toBe(2);
      expect(j.deleted.map((d: { id: string }) => d.id).sort()).toEqual([ids.mainAll, ids.mainKr].sort());
      for (const id of [ids.mainAll, ids.mainKr]) {
        expect(await prisma.analysisRun.findUnique({ where: { id } })).toBeNull();
        expect(await prisma.analysisRunDimension.count({ where: { analysisRunId: id } })).toBe(0);
        expect(await prisma.analysisInterpretation.count({ where: { analysisRunId: id } })).toBe(0);
      }
      for (const id of keep) {
        expect(await prisma.analysisRun.findUnique({ where: { id } })).not.toBeNull();
        expect(await prisma.analysisRunDimension.count({ where: { analysisRunId: id } })).toBe(1);
      }
      expect((await prisma.analysisRun.findMany({ where: { algorithmVersion: "2.0.0" }, select: { id: true } })).map((r) => r.id).sort()).toEqual(currentBefore.map((r) => r.id).sort());
      expect(await prisma.analysisPackage.count()).toBe(packagesBefore);
      expect(await rawHashes()).toEqual(rawBefore);
      expect({ sessions: await prisma.sortSession.count(), groups: await prisma.sortGroup.count(), items: await prisma.sortGroupItem.count() }).toEqual(counts);
      expect((await get0()).targetCount).toBe(0); // idempotent
    });
  });
});
