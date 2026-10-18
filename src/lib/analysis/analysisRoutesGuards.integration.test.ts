/**
 * Guards of the NEW result routes (bundle / overview / package / cleanup). These replace, for the new endpoints, what the
 * removed export-data tests used to pin: auth (401), cross-project (404), every freshness gate (numeric, KO/JA content,
 * publication, parameters, FAILED run), pilot/main separation, unsigned seeds and the personal-data marker audit.
 */
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { zipSync, strToU8 } from "fflate";
import { createHash } from "node:crypto";

const dbFile = path.join(os.tmpdir(), `concept-sort-guards-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
const MIGRATIONS_DIR = path.resolve(process.cwd(), "prisma/migrations");
{
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA foreign_keys = ON;");
  for (const name of fs.readdirSync(MIGRATIONS_DIR).filter((n) => /^\d{14}_/.test(n)).sort()) db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf-8"));
  db.close();
}
process.env.DATABASE_URL = `file:${dbFile}`;

const { prisma } = await import("@/lib/db");
const bundleRoute = await import("@/app/api/projects/[slug]/analysis/runs/[runId]/bundle/route");
const packageRoute = await import("@/app/api/projects/[slug]/analysis/runs/[runId]/package/route");
const overviewRoute = await import("@/app/api/projects/[slug]/analysis/overview/route");
const cleanupRoute = await import("@/app/api/projects/[slug]/analysis/cleanup-superseded/route");
const { createAnalysisRun, executeAnalysisRun, fromStoredSeed } = await import("@/lib/analysis/executionService");
const { DEFAULT_ANALYSIS_PARAMETERS, VALIDATION_BASELINE_SHA } = await import("@/lib/analysis/config");

const LIGHT = { ...DEFAULT_ANALYSIS_PARAMETERS, dimensionsEvaluated: [1, 2, 3], nInit: 8, maxIter: 3000, strictMaxIter: 6000, splitHalfRepetitions: 50 };
const N_ST = 8;
const MARKER_NAME = "PARTICIPANT-NAME-MARKER";
const MARKER_PHONE = "010-5555-4444";
const MARKER_LABEL = "PILE-LABEL-MARKER";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let seed = 11;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

async function seedProject(slug: string, withData: boolean) {
  const project = await prisma.project.create({ data: { slug, adminToken: `token-${slug}`, title: "t", prompt: "p", consentKo: "c", koPreviewConfirmedAt: new Date(), titleJa: "t", promptJa: "p", consentJa: "c", jaPreviewConfirmedAt: new Date() } });
  const sts = [];
  for (let i = 0; i < N_ST; i++) sts.push(await prisma.statement.create({ data: { projectId: project.id, text: `문항 ${i}`, textJa: `項目 ${i}`, jaStatus: "APPROVED", order: i } }));
  const ids = sts.map((s) => s.id);
  const addSession = async (country: "KR" | "JP", role: "MAIN" | "PILOT") => {
    const pile = ids.map((_, s) => (rnd() < 0.15 ? Math.floor(rnd() * 2) : Math.floor(s / 4)));
    const groups = [0, 1].map((g) => ids.filter((_, s) => pile[s] === g)).filter((g) => g.length > 0);
    await prisma.sortSession.create({ data: { projectId: project.id, participantName: MARKER_NAME, gender: "x", age: 20, schoolLevel: "x", grade: "x", phoneNumber: MARKER_PHONE, countryCode: country, dataRole: role, groups: { create: groups.map((g) => ({ label: MARKER_LABEL, items: { create: g.map((statementId) => ({ statementId })) } })) } } });
  };
  if (withData) {
    for (let i = 0; i < 6; i++) await addSession("KR", "MAIN");
    for (let i = 0; i < 6; i++) await addSession("JP", "MAIN");
    await addSession("KR", "PILOT");
  }
  return { project, ids, addSession };
}

const A = await seedProject("guards-a", true);
await seedProject("guards-b", false); // second project: its valid token must not reach project A runs
const req = (slug: string, url: string, init?: RequestInit, token?: string | null) =>
  new NextRequest(`http://localhost${url}`, { ...init, headers: { ...(token === null ? {} : { Authorization: `Bearer ${token ?? `token-${slug}`}` }), ...(init?.headers ?? {}) } } as never);
const ctx = (slug: string, runId?: string) => ({ params: Promise.resolve(runId ? { slug, runId } : { slug }) });

async function newRun(scope: "KR" | "JP" | "ALL", dataset: "MAIN" | "PILOT" = "MAIN", params = LIGHT) {
  const { runId } = await createAnalysisRun({ prisma, projectId: A.project.id, scope, dataset, analysisParameters: params, validationBaselineSha: VALIDATION_BASELINE_SHA, engineSourceCommitSha: "a".repeat(40) });
  await executeAnalysisRun(prisma, runId);
  return prisma.analysisRun.findUniqueOrThrow({ where: { id: runId } });
}
function zipFor(run: { id: string; scope: string; resultBundle: string | null }) {
  const f = JSON.parse(run.resultBundle!).meta.fingerprints;
  const files: Record<string, Uint8Array> = { "pkg/README.txt": strToU8("hello") };
  const manifest = { manifestVersion: 1, runId: run.id, scope: run.scope, zipFilename: `${run.scope}.zip`, fingerprints: { participantsHash: f.participantsHash, numericDataHash: f.numericDataHash, parameterHash: f.parameterHash }, files: Object.entries(files).map(([p, b]) => ({ path: p.replace(/^pkg\//, ""), sha256: sha(b), bytes: b.byteLength })) };
  return zipSync({ ...files, "pkg/manifest.json": strToU8(JSON.stringify(manifest)) });
}
const getBundle = async (run: { id: string }, slug = "guards-a", token?: string | null) => bundleRoute.GET(req(slug, `/x`, undefined, token), ctx(slug, run.id));
const getPackage = async (run: { id: string }, slug = "guards-a", token?: string | null) => packageRoute.GET(req(slug, `/x`, undefined, token), ctx(slug, run.id));
const putPackage = async (run: { id: string }, bytes: Uint8Array, slug = "guards-a", token?: string | null) => packageRoute.PUT(req(slug, `/x`, { method: "PUT", body: bytes as never, headers: { "x-package-sha256": sha(bytes) } }, token), ctx(slug, run.id));

describe("authentication and project isolation on the new routes", () => {
  it("every route answers 401 without a valid Bearer token and 404 for another project's run", async () => {
    const run = await newRun("KR");
    for (const token of [null, "wrong-token"]) {
      expect((await getBundle(run, "guards-a", token)).status).toBe(401);
      expect((await getPackage(run, "guards-a", token)).status).toBe(401);
      expect((await putPackage(run, zipFor(run), "guards-a", token)).status).toBe(401);
      expect((await overviewRoute.GET(req("guards-a", "/x", undefined, token), ctx("guards-a"))).status).toBe(401);
      expect((await cleanupRoute.GET(req("guards-a", "/x", undefined, token), ctx("guards-a"))).status).toBe(401);
      expect((await cleanupRoute.POST(req("guards-a", "/x", { method: "POST", body: "{}" }, token), ctx("guards-a"))).status).toBe(401);
    }
    // project B's valid token must not reach project A's run, and the answer is the same as for a missing run
    expect((await getBundle(run, "guards-b")).status).toBe(404);
    expect((await getPackage(run, "guards-b")).status).toBe(404);
    expect((await putPackage(run, zipFor(run), "guards-b")).status).toBe(404);
  });
});

describe("freshness gates block the result body and the download (what export-data used to guarantee)", () => {
  it("a current COMPLETED run is exposed as official and its seeds are unsigned", async () => {
    const run = await newRun("KR");
    const j = await (await getBundle(run)).json();
    expect(j.officialResult).toBe(true);
    expect(j.resultBodyBlocked).toBe(false);
    const dims = j.bundle.analysis.dimensions as { selected: { seed: number } | null; starts: { seed: number }[] }[];
    for (const d of dims) {
      if (d.selected) expect(d.selected.seed).toBeGreaterThanOrEqual(0);
      for (const s of d.starts) expect(s.seed).toBeGreaterThanOrEqual(0);
    }
    // the stored column is a signed Int32 reinterpretation; decoding gives back the unsigned seed shown in the bundle
    const stored = await prisma.analysisRunDimension.findMany({ where: { analysisRunId: run.id } });
    for (const row of stored) {
      const d = j.bundle.analysis.dimensions.find((x: { dimension: number }) => x.dimension === row.dimension);
      expect(fromStoredSeed(row.bestSeed)).toBe(d.selected.seed);
    }
  });

  it("numeric stale (a new MAIN response arrives), KO/JA content change, publication not ready and superseded parameters each block body and download", async () => {
    const run = await newRun("JP");
    expect((await putPackage(run, zipFor(run))).status).toBe(200);
    expect((await getPackage(run)).status).toBe(200);
    const blocked = async (label: string) => {
      const j = await (await getBundle(run)).json();
      expect(j.resultBodyBlocked, label).toBe(true);
      expect(j.bundle, label).toBeUndefined();
      const p = await getPackage(run);
      expect(p.status, label).toBe(409);
      expect((await p.json()).errorCode).toBe("RESULT_NOT_CURRENT");
    };
    // (a) numeric: a new valid JP response
    await A.addSession("JP", "MAIN");
    await blocked("numeric");
    await prisma.sortSession.delete({ where: { id: (await prisma.sortSession.findFirstOrThrow({ where: { countryCode: "JP", dataRole: "MAIN" }, orderBy: { createdAt: "desc" } })).id } });
    expect((await getPackage(run)).status).toBe(200);
    // (b) Korean statement text changed
    const st = await prisma.statement.findFirstOrThrow({ where: { projectId: A.project.id }, orderBy: { order: "asc" } });
    await prisma.statement.update({ where: { id: st.id }, data: { text: "변경된 문항" } });
    await blocked("content-ko");
    await prisma.statement.update({ where: { id: st.id }, data: { text: st.text } });
    // (c) Japanese statement text changed
    await prisma.statement.update({ where: { id: st.id }, data: { textJa: "変更された項目" } });
    await blocked("content-ja");
    await prisma.statement.update({ where: { id: st.id }, data: { textJa: st.textJa } });
    // (d) publication not ready: a JP-scope result depends on the Japanese locale only, so the Korean confirmation is irrelevant
    await prisma.project.update({ where: { id: A.project.id }, data: { koPreviewConfirmedAt: null } });
    expect((await getPackage(run)).status).toBe(200);
    await prisma.project.update({ where: { id: A.project.id }, data: { koPreviewConfirmedAt: new Date(), jaPreviewConfirmedAt: null } });
    await blocked("publication");
    await prisma.project.update({ where: { id: A.project.id }, data: { jaPreviewConfirmedAt: new Date() } });
    // (e) the run's stored parameters no longer match the live configuration
    const snap = JSON.parse(run.parametersSnapshot);
    snap.analysisParameters.nInit = 999;
    await prisma.analysisRun.update({ where: { id: run.id }, data: { parametersSnapshot: JSON.stringify(snap) } });
    await blocked("parameters");
    await prisma.analysisRun.update({ where: { id: run.id }, data: { parametersSnapshot: run.parametersSnapshot } });
    expect((await getPackage(run)).status).toBe(200);
    await prisma.analysisPackage.deleteMany({ where: { analysisRunId: run.id } });
  });

  it("a FAILED run shows its failure (not an official result), has no download and cannot take a package", async () => {
    const run = await newRun("KR", "MAIN", { ...LIGHT, nInit: 2, maxIter: 2, strictMaxIter: 2 });
    expect(run.executionStatus).toBe("FAILED");
    const j = await (await getBundle(run)).json();
    expect(j.officialResult).toBe(false);
    expect(j.errorCode).toBe("MDS_NOT_CONVERGED");
    expect(j.bundle.analysis.solutions).toEqual([]);
    expect((await getPackage(run)).status).toBe(409);
    expect((await putPackage(run, zipFor(run))).status).toBe(409);
  });
});

describe("pilot / main separation", () => {
  it("a PILOT-dataset run is never the official result and never takes a package", async () => {
    const pilot = await newRun("ALL", "PILOT");
    expect(pilot.executionStatus).toBe("COMPLETED");
    expect((await putPackage(pilot, zipFor(pilot))).status).toBe(409);
    const ov = await (await overviewRoute.GET(req("guards-a", "/x"), ctx("guards-a"))).json();
    for (const s of ["KR", "JP", "ALL"]) {
      expect(ov.scopes[s].official?.id).not.toBe(pilot.id);
      expect(ov.scopes[s].history.some((h: { id: string }) => h.id === pilot.id)).toBe(false);
    }
    expect(pilot.mainCount).toBe(0);
  });
});

describe("personal-data marker audit of stored results", () => {
  it("participant names, phone numbers and pile labels typed by participants never reach the snapshot or the result bundle", async () => {
    const run = await newRun("ALL");
    for (const text of [run.inputSnapshot, run.resultBundle ?? "", run.parametersSnapshot]) {
      for (const m of [MARKER_NAME, MARKER_PHONE, MARKER_LABEL]) expect(text).not.toContain(m);
    }
    for (const s of await prisma.sortSession.findMany({ select: { id: true } })) expect(run.inputSnapshot).not.toContain(s.id);
    const ps = JSON.parse(run.inputSnapshot).participants as { pid: string }[];
    expect(ps.every((p) => /^(KR|JP)-\d{3}$/.test(p.pid))).toBe(true);
  });
});
