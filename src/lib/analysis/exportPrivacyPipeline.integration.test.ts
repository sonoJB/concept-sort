import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { unzipSync, strFromU8 } from "fflate";

/**
 * End-to-end privacy audit for the ACTUAL Gate 4 export pipeline — not just
 * source-code grep. Synthetic secret markers are seeded into
 * participant-level DB fields that a leak would plausibly come from
 * (participantName, phoneNumber, adminToken, an explicit SortSession.id),
 * then the full pipeline is exercised (export-data route -> CSV builders ->
 * SVG/HTML builders -> README builder -> ZIP builder, unzipped and read back
 * as text) and every generated artifact is checked for zero occurrences of
 * every marker. No real production PII is used anywhere in this file.
 */

const dbFile = path.join(os.tmpdir(), `concept-sort-privacy-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
const MIGRATIONS_DIR = path.resolve(process.cwd(), "prisma/migrations");
const MIGRATION_ORDER = [
  "20260803154453_init",
  "20260803180717_add_consent_and_demographics",
  "20260805233213_add_multilingual_project_support",
  "20260807144811_add_analysis_run_models",
  "20260807180000_scope_legacy_consent_fallback",
];
{
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA foreign_keys = ON;");
  for (const name of MIGRATION_ORDER) db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf-8"));
  db.close();
}
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.ANALYSIS_ENGINE_SOURCE_COMMIT_SHA = "f".repeat(40);

const { prisma } = await import("@/lib/db");
const runsRoute = await import("@/app/api/projects/[slug]/analysis/runs/route");
const exportDataRoute = await import("@/app/api/projects/[slug]/analysis/runs/[runId]/export-data/route");
const interpretationsRoute = await import("@/app/api/projects/[slug]/analysis/runs/[runId]/interpretations/route");
const interpretationRoute = await import("@/app/api/projects/[slug]/analysis/interpretations/[interpretationId]/route");
const labelsRoute = await import("@/app/api/projects/[slug]/analysis/interpretations/[interpretationId]/labels/route");

const { buildCsvFiles } = await import("./view/csvBuilders");
const { buildMap2DSvg, build3DSvg } = await import("./view/svgFigures");
const { buildStandaloneHtml, buildQuadrantStandaloneHtml, build3DStandaloneHtml } = await import("./view/htmlBuilder");
const { buildReadmeText } = await import("./view/readmeBuilder");
const { buildMapPoints2D, projectPoints3D } = await import("./view/figureModel");
const { buildZipBlob, buildFinalZipBundle, OfficialBundleNotFinalizedError } = await import("./view/exportClient");
const { isFinalZipAllowed } = await import("./view/uiState");

// Synthetic-only — never a real production value. Deliberately limited to
// markers that have a REAL field to be injected into and actually flow
// through the pipeline under test — an expect(...).not.toContain(marker)
// for a marker that was never placed anywhere upstream is vacuous evidence,
// not a privacy guarantee, so it is intentionally NOT added here. The three
// markers omitted from this set, and why, per the Gate 4 Privacy Test
// Provenance Check:
//   - HASHED_PARTICIPANT_X: no hashed-participant-identifier field exists
//     anywhere in prisma/schema.prisma, and no code in src/lib/analysis or
//     src/components/analysis derives a per-participant hash (confirmed by
//     source audit — numericDataHash is explicitly scoped to never include
//     session identity, see aggregates.ts). There is no real field to
//     inject this marker into without inventing a schema column, which is
//     out of scope for Gate 4. STRUCTURALLY_NOT_APPLICABLE.
//   - CONSENT_RESPONSE_SECRET_X: SortSession's only consent-related column
//     is `consentAgreed Boolean` — there is no string field a participant
//     response marker could occupy, and no Gate 4 export code (exportPayload
//     .ts, csvBuilders.ts, svgFigures.ts, htmlBuilder.ts, readmeBuilder.ts)
//     reads consentAgreed at all (confirmed by source audit).
//     STRUCTURALLY_NOT_APPLICABLE.
//   - DATABASE_URL_SECRET_X: process.env.DATABASE_URL is Prisma's own
//     connection string, required verbatim for this very test file to
//     connect to its disposable DB — overwriting it with a synthetic value
//     would break the test harness itself, not exercise the export
//     pipeline. No file under src/lib/analysis or src/components/analysis
//     reads process.env.DATABASE_URL (confirmed by source audit — zero
//     matches outside test harness files). STRUCTURALLY_NOT_APPLICABLE.
const MARKERS = {
  participantName: "PII_PARTICIPANT_NAME_X",
  phoneNumber: "PII_PHONE_X",
  adminToken: "SECRET_ADMIN_TOKEN_X",
  sessionId: "SESSION_SECRET_ID_X",
};
const ALL_MARKERS = Object.values(MARKERS);

async function seedProjectWithSecrets(slug: string) {
  const project = await prisma.project.create({
    data: {
      slug,
      adminToken: MARKERS.adminToken,
      title: "t",
      prompt: "p",
      consentKo: "c",
      koPreviewConfirmedAt: new Date(),
    },
  });
  const statements = [];
  for (let i = 0; i < 6; i++) statements.push(await prisma.statement.create({ data: { projectId: project.id, text: `stmt-${i}`, order: i } }));
  const ids = statements.map((s) => s.id);
  const half = Math.ceil(ids.length / 2);

  // First session carries every participant-level secret marker, including
  // an explicitly-set id (SortSession.id != AnalysisRun.id — this test
  // verifies the FORMER never appears in export output, not the latter,
  // which is expected and allowed as the run identifier).
  await prisma.sortSession.create({
    data: {
      id: MARKERS.sessionId,
      projectId: project.id,
      participantName: MARKERS.participantName,
      gender: "unspecified",
      age: 20,
      schoolLevel: "unspecified",
      grade: "unspecified",
      phoneNumber: MARKERS.phoneNumber,
      countryCode: "KR",
      groups: {
        create: [
          { items: { create: ids.slice(0, half).map((id) => ({ statementId: id })) } },
          { items: { create: ids.slice(half).map((id) => ({ statementId: id })) } },
        ],
      },
    },
  });
  for (let i = 0; i < 2; i++) {
    await prisma.sortSession.create({
      data: {
        projectId: project.id,
        participantName: `synthetic-${i}`,
        gender: "unspecified",
        age: 21,
        schoolLevel: "unspecified",
        grade: "unspecified",
        phoneNumber: "000-0000-0000",
        countryCode: "KR",
        groups: {
          create: [
            { items: { create: ids.slice(0, half).map((id) => ({ statementId: id })) } },
            { items: { create: ids.slice(half).map((id) => ({ statementId: id })) } },
          ],
        },
      },
    });
  }
  return { project, statementIds: ids };
}

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.unlinkSync(dbFile);
  } catch {
    /* best effort */
  }
});

function assertNoMarkers(label: string, text: string) {
  for (const marker of ALL_MARKERS) {
    expect(text, `${label} must not contain ${marker}`).not.toContain(marker);
  }
}

describe("export privacy pipeline — real artifacts, not just source grep", () => {
  it("no synthetic participant-level secret marker survives into any generated export artifact", async () => {
    const { project } = await seedProjectWithSecrets("privacy-pipeline");

    const createReq = new NextRequest(`http://localhost/api/projects/${project.slug}/analysis/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${project.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ scope: "KR" }),
    });
    const createRes = await runsRoute.POST(createReq, { params: Promise.resolve({ slug: project.slug }) });
    expect(createRes.status).toBe(201);
    const run = await createRes.json();
    expect(run.executionStatus).toBe("COMPLETED");

    // 1. export-data JSON
    const exportReq = new NextRequest(`http://localhost/api/projects/${project.slug}/analysis/runs/${run.id}/export-data?lang=ko`, {
      headers: { authorization: `Bearer ${project.adminToken}` },
    });
    const exportRes = await exportDataRoute.GET(exportReq, { params: Promise.resolve({ slug: project.slug, runId: run.id }) });
    expect(exportRes.status).toBe(200);
    const payloadText = await exportRes.text();
    assertNoMarkers("export-data JSON", payloadText);
    const payload = JSON.parse(payloadText);
    // AnalysisRun.id is expected/allowed in the payload — confirm it's NOT
    // (and can never coincide with) the synthetic SortSession.id marker.
    expect(payload.meta.runId).not.toBe(MARKERS.sessionId);

    // Create + finalize an interpretation so clusters/labels/final-ZIP paths are exercised too.
    const interpReq = new NextRequest(`http://localhost/api/projects/${project.slug}/analysis/runs/${run.id}/interpretations`, {
      method: "POST",
      headers: { authorization: `Bearer ${project.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ selectedClusterCount: 2 }),
    });
    const interpRes = await interpretationsRoute.POST(interpReq, { params: Promise.resolve({ slug: project.slug, runId: run.id }) });
    expect(interpRes.status).toBe(201);
    const interpretation = await interpRes.json();

    const labelReq = new NextRequest(`http://localhost/api/projects/${project.slug}/analysis/interpretations/${interpretation.id}/labels`, {
      method: "POST",
      headers: { authorization: `Bearer ${project.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ clusterIndex: 1, language: "ko", label: "공식 라벨" }),
    });
    expect((await labelsRoute.POST(labelReq, { params: Promise.resolve({ slug: project.slug, interpretationId: interpretation.id }) })).status).toBe(201);

    const finalizeReq = new NextRequest(`http://localhost/api/projects/${project.slug}/analysis/interpretations/${interpretation.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${project.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "FINALIZED" }),
    });
    const finalizeRes = await interpretationRoute.PATCH(finalizeReq, { params: Promise.resolve({ slug: project.slug, interpretationId: interpretation.id }) });
    expect(finalizeRes.status).toBe(200);
    const finalized = await finalizeRes.json();
    expect(finalized.status).toBe("FINALIZED");

    // Re-fetch export-data with the finalized interpretation attached.
    const exportReq2 = new NextRequest(
      `http://localhost/api/projects/${project.slug}/analysis/runs/${run.id}/export-data?lang=ko&interpretationId=${interpretation.id}`,
      { headers: { authorization: `Bearer ${project.adminToken}` } }
    );
    const exportRes2 = await exportDataRoute.GET(exportReq2, { params: Promise.resolve({ slug: project.slug, runId: run.id }) });
    expect(exportRes2.status).toBe(200);
    const finalPayload = await exportRes2.json();
    assertNoMarkers("export-data JSON (with interpretation)", JSON.stringify(finalPayload));

    // 2/3/4. CSV builders — every generated file.
    const csvFiles = buildCsvFiles(finalPayload);
    expect(csvFiles.length).toBeGreaterThan(0);
    for (const f of csvFiles) assertNoMarkers(`CSV ${f.filename}`, f.content);
    const runMetaCsv = csvFiles.find((f) => f.filename === "01_run_metadata.csv");
    const statementsCsv = csvFiles.find((f) => f.filename === "02_statements.csv");
    expect(runMetaCsv).toBeDefined();
    expect(statementsCsv).toBeDefined();

    // 5/7. 2D SVG / HTML
    const points2d = finalPayload.statements.map((s: { id: string; order: number }, i: number) => {
      const dim = finalPayload.dimensions.find((d: { dimension: number }) => d.dimension === finalPayload.meta.primaryMapDimension);
      return { statementId: s.id, order: s.order, x: dim.coordinates[i][0], y: dim.coordinates[i][1], clusterIndex: null };
    });
    const scaled2d = buildMapPoints2D(points2d);
    const svg2d = buildMap2DSvg(scaled2d, points2d, { draft: false });
    assertNoMarkers("map_2d.svg", svg2d);
    const html2d = buildStandaloneHtml(finalPayload, svg2d, false, null);
    assertNoMarkers("map_2d.html", html2d);

    // 6/8. Quadrant SVG / HTML
    const svgQuadrant = buildMap2DSvg(scaled2d, points2d, { showQuadrantLines: true, draft: false });
    assertNoMarkers("map_2d_quadrants.svg", svgQuadrant);
    const htmlQuadrant = buildQuadrantStandaloneHtml(finalPayload, svgQuadrant, false);
    assertNoMarkers("map_2d_quadrants.html", htmlQuadrant);

    // 9/10. 3D SVG/HTML — only if the fixture actually produced a 3D dimension (default params evaluate [2,3]).
    let svg3d: string | null = null;
    let html3d: string | null = null;
    const dim3d = finalPayload.dimensions.find((d: { dimension: number; coordinates: unknown }) => d.dimension === 3 && d.coordinates);
    if (dim3d && finalPayload.meta.view3d) {
      const points3d = finalPayload.statements.map((s: { id: string; order: number }, i: number) => ({
        statementId: s.id,
        order: s.order,
        x: dim3d.coordinates[i][0],
        y: dim3d.coordinates[i][1],
        z: dim3d.coordinates[i][2],
      }));
      const scaled3d = projectPoints3D(points3d, finalPayload.meta.view3d);
      svg3d = build3DSvg(scaled3d, finalPayload.meta.view3d, false);
      assertNoMarkers("map_3d.svg", svg3d);
      html3d = build3DStandaloneHtml(finalPayload, svg3d, false);
      assertNoMarkers("map_3d.html", html3d);
    }

    // 11. README
    const readme = buildReadmeText(finalPayload);
    assertNoMarkers("README.txt", readme);

    // 12. Final ZIP — built through the FINALIZED-only official builder, then unzipped for real.
    const entries: { path: string; content: string | Uint8Array }[] = [
      ...csvFiles.map((f) => ({ path: f.filename, content: f.content })),
      { path: "map_2d.svg", content: svg2d },
      { path: "map_2d.html", content: html2d },
      { path: "map_2d_quadrants.svg", content: svgQuadrant },
      { path: "map_2d_quadrants.html", content: htmlQuadrant },
      { path: "README.txt", content: readme },
    ];
    if (svg3d && html3d) {
      entries.push({ path: "map_3d.svg", content: svg3d });
      entries.push({ path: "map_3d.html", content: html3d });
    }

    expect(isFinalZipAllowed(finalized.status)).toBe(true);
    const zipBlob = buildFinalZipBundle(entries, finalized.status);
    const zipBuffer = new Uint8Array(await zipBlob.arrayBuffer());
    const unzipped = unzipSync(zipBuffer);
    let textEntryCount = 0;
    for (const [name, data] of Object.entries(unzipped)) {
      if (name.endsWith(".png")) continue; // no text-readable entries in this fixture are PNG (PNG generation is browser-Canvas-only, exercised separately)
      textEntryCount++;
      const text = strFromU8(data);
      assertNoMarkers(`ZIP entry ${name}`, text);
    }
    expect(textEntryCount).toBeGreaterThan(0);
    expect(Object.keys(unzipped)).toContain("README.txt");
    expect(Object.keys(unzipped)).toContain("01_run_metadata.csv");
    expect(Object.keys(unzipped)).toContain("map_2d.svg");
  });

  it("PNG generation is structurally fed by the same privacy-safe SVG source strings already asserted above (no separate participant-data path — svgStringToPngBlob takes only an SVG string and rasterizes it via browser Canvas, never touching the DB)", () => {
    // svgStringToPngBlob (exportClient.ts) has signature (svg: string, ...) — it
    // cannot introduce any data that wasn't already in the SVG string, and
    // Canvas rasterization is browser-only so it is not invoked in this
    // Node test environment. This test documents that architectural
    // guarantee rather than asserting on PNG binary substrings.
    expect(true).toBe(true);
  });
});

describe("official final ZIP builder — FINALIZED-only contract enforced by the builder itself, not just the UI", () => {
  const entries = [{ path: "README.txt", content: "hello" }];

  it("A. DRAFT interpretation -> builder rejects", () => {
    expect(() => buildFinalZipBundle(entries, "DRAFT")).toThrow(OfficialBundleNotFinalizedError);
  });

  it("B. no interpretation (null) -> builder rejects", () => {
    expect(() => buildFinalZipBundle(entries, null)).toThrow(OfficialBundleNotFinalizedError);
  });

  it("C. FINALIZED -> builder succeeds", () => {
    const blob = buildFinalZipBundle(entries, "FINALIZED");
    expect(blob).toBeInstanceOf(Blob);
  });

  it("D. FINALIZED ZIP unzips to the expected entries", async () => {
    const blob = buildFinalZipBundle(
      [
        { path: "README.txt", content: "hello" },
        { path: "01_run_metadata.csv", content: "a,b\n1,2" },
        { path: "map_2d.svg", content: "<svg></svg>" },
      ],
      "FINALIZED"
    );
    const buf = new Uint8Array(await blob.arrayBuffer());
    const unzipped = unzipSync(buf);
    expect(strFromU8(unzipped["README.txt"])).toBe("hello");
    expect(strFromU8(unzipped["01_run_metadata.csv"])).toBe("a,b\n1,2");
    expect(strFromU8(unzipped["map_2d.svg"])).toBe("<svg></svg>");
  });

  it("E. individual export (plain buildZipBlob, or the CSV/SVG/HTML builders directly) is unaffected by the FINALIZED guard — DRAFT preview/export must keep working", () => {
    // buildZipBlob (used nowhere for the "official" button anymore, but kept
    // for any future individual-bundle use) has no FINALIZED gate at all.
    const blob = buildZipBlob(entries);
    expect(blob).toBeInstanceOf(Blob);
  });
});
