import { describe, it, expect } from "vitest";
import { parseCsv } from "@/lib/csv";
import { buildCsvFiles } from "./csvBuilders";
import { escapeXml, buildMap2DSvg, build3DSvg } from "./svgFigures";
import { buildStandaloneHtml, buildQuadrantStandaloneHtml, build3DStandaloneHtml } from "./htmlBuilder";
import { buildReadmeText } from "./readmeBuilder";
import { buildMapPoints2D } from "./figureModel";
import { buildExportPayload, type ExportPayload } from "./exportPayload";

const TRICKY_TEXT = 'A "quoted", multi\nline 값, 한국어 텍스트, 日本語のテキスト';
const XSS_MARKER = "<script>alert('xss')</script>";

function makePayload(overrides: Partial<ExportPayload["meta"]> = {}): ExportPayload {
  return {
    meta: {
      projectSlug: "test-slug",
      scope: "KR",
      runId: "run123456789",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:10.000Z",
      includedParticipantCount: 3,
      nKr: 3,
      nJp: 0,
      statementCount: 2,
      algorithmVersion: "1.0.0",
      engineSourceCommitSha: "a".repeat(40),
      validationBaselineSha: "d2e41f5c",
      parameterHash: "ph",
      numericDataHash: "ndh",
      statementStructureHash: "ssh",
      statementContentHashKo: "kch",
      statementContentHashJa: "jch",
      primaryMapDimension: 2,
      wardSourceDimension: 2,
      linkageMethod: "ward",
      executionStatus: "COMPLETED",
      wardStatus: "COMPLETED",
      exportGeneratedAt: "2026-01-02T00:00:00.000Z",
      exportLanguage: "ko",
      selectedClusterCount: null,
      interpretationVersion: null,
      interpretationStatus: null,
      axisLabels: null,
      quadrantLabels: null,
      notes: null,
      view3d: null,
      ...overrides,
    },
    statements: [
      { id: "s1", order: 0, text: TRICKY_TEXT, jaStatus: null },
      { id: "s2", order: 1, text: XSS_MARKER, jaStatus: null },
    ],
    numeric: { similarityCountMatrix: [[0, 1], [1, 0]], similarityProportionMatrix: [[0, 1], [1, 0]], dissimilarityMatrix: [[0, 0], [0, 0]] },
    dimensions: [
      { dimension: 2, dimensionStatus: "COMPLETED", coordinates: [[0, 0], [1, 1]], rawStress: 0.01, commonStressDistance: 0.01, commonStressQ: 0.02, converged: true, iterations: 5, bestInitIndex: 0, bestSeed: 4294967295, errorCode: null, errorMessageSafe: null, rSquared: 0.99, rsq: 0.99, convergenceReason: "CONVERGED" },
    ],
    ward: null,
    clusters: null,
    interpretationLabels: [{ clusterIndex: 1, language: "ko", label: TRICKY_TEXT, memo: XSS_MARKER }],
  };
}

describe("CSV escaping round-trip", () => {
  it("preserves comma/quote/newline/Korean/Japanese text through the full CSV encode+parse cycle", () => {
    const payload = makePayload();
    const files = buildCsvFiles(payload);
    const statementsFile = files.find((f) => f.filename === "02_statements.csv")!;
    const parsed = parseCsv(statementsFile.content);
    // header + 2 statement rows
    expect(parsed.length).toBe(3);
    const row1 = parsed[1];
    expect(row1[2]).toBe(TRICKY_TEXT); // exact round-trip, including embedded quote/comma/newline
  });

  it("does not execute or mis-encode an XSS-marker statement — it survives as inert text", () => {
    const payload = makePayload();
    const files = buildCsvFiles(payload);
    const statementsFile = files.find((f) => f.filename === "02_statements.csv")!;
    const parsed = parseCsv(statementsFile.content);
    expect(parsed[2][2]).toBe(XSS_MARKER);
  });

  it("run metadata CSV never contains a raw negative bestSeed anywhere", () => {
    const payload = makePayload();
    const files = buildCsvFiles(payload);
    const diagCsv = files.find((f) => f.filename === "06_mds_diagnostics.csv")!;
    expect(diagCsv.content).toContain("4294967295");
    expect(diagCsv.content).not.toMatch(/-1\b/);
  });
});

describe("SVG/HTML escaping", () => {
  it("escapeXml neutralizes all five XML-significant characters", () => {
    expect(escapeXml(`< > & " '`)).toBe("&lt; &gt; &amp; &quot; &apos;");
  });

  it("an XSS-marker researcher label in the 2D map SVG appears only as escaped text, never as a live <script> element", () => {
    const scaled = buildMapPoints2D([{ statementId: "s1", order: 0, x: 0, y: 0, clusterIndex: null }]);
    const svg = buildMap2DSvg(scaled, [{ statementId: "s1", order: 0, x: 0, y: 0, clusterIndex: null }], {
      axisLabels: { positiveX: XSS_MARKER },
    });
    expect(svg).not.toContain("<script>alert('xss')</script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("standalone HTML export escapes interpretation labels and never contains a raw <script> tag", () => {
    const payload = makePayload();
    const scaled = buildMapPoints2D([{ statementId: "s1", order: 0, x: 0, y: 0, clusterIndex: null }]);
    const svg = buildMap2DSvg(scaled, [{ statementId: "s1", order: 0, x: 0, y: 0, clusterIndex: null }], {});
    const html = buildStandaloneHtml(payload, svg, false, null);
    expect(html).not.toContain("<script>alert('xss')</script>");
    expect(html.toLowerCase()).not.toContain("<script>");
  });

  it("quadrant standalone HTML escapes labels, never contains a raw <script> tag, and marks itself as supplementary", () => {
    const payload = makePayload();
    const scaled = buildMapPoints2D([{ statementId: "s1", order: 0, x: 0, y: 0, clusterIndex: null }]);
    const svg = buildMap2DSvg(scaled, [{ statementId: "s1", order: 0, x: 0, y: 0, clusterIndex: null }], { showQuadrantLines: true });
    const html = buildQuadrantStandaloneHtml(payload, svg, false);
    expect(html).not.toContain("<script>alert('xss')</script>");
    expect(html.toLowerCase()).not.toContain("<script>");
    expect(html).toContain("보조자료");
  });

  it("3D standalone HTML is only meaningful when a 3D dimension is present, escapes text, never contains a raw <script> tag, and records azimuth/elevation", () => {
    const payload = makePayload({ view3d: { azimuthDeg: 35, elevationDeg: 20 } });
    const svg3d = build3DSvg(
      [{ statementId: "s1", order: 0, x: 0, y: 0, z: 0, sx: 10, sy: 10, depth: 0 }],
      { azimuthDeg: 35, elevationDeg: 20 }
    );
    const html = build3DStandaloneHtml(payload, svg3d, false);
    expect(html).not.toContain("<script>alert('xss')</script>");
    expect(html.toLowerCase()).not.toContain("<script>");
    expect(html).toContain("35");
    expect(html).toContain("20");
    expect(html).toContain("보조자료");
  });
});

const AXIS_XSS = "AXIS <script>alert('axis')</script>";
const QUADRANT_XSS = "<b>QUADRANT</b>";
const NOTES_XSS = 'NOTES "comma",\nnewline,\n<script>alert(\'notes\')</script>';

describe("interpretation export completeness — axis/quadrant labels and notes (Gate 6.1)", () => {
  const points = [{ statementId: "s1", order: 0, x: 0, y: 0, clusterIndex: null }];
  const scaled = buildMapPoints2D(points);

  it("A. axis label appears in the 2D SVG as escaped text, never as a live <script> element", () => {
    const payload = makePayload({ axisLabels: AXIS_XSS });
    const svg = buildMap2DSvg(scaled, points, { axisLabels: payload.meta.axisLabels ? { positiveX: payload.meta.axisLabels } : null });
    expect(svg).not.toContain("<script>alert('axis')</script>");
    expect(svg).toContain("AXIS");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("B. axis label appears in the 2D standalone HTML", () => {
    const payload = makePayload({ axisLabels: "AXIS_LABEL_TEXT" });
    const svg = buildMap2DSvg(scaled, points, { axisLabels: { positiveX: payload.meta.axisLabels! } });
    const html = buildStandaloneHtml(payload, svg, false, null);
    expect(html).toContain("AXIS_LABEL_TEXT");
  });

  it("C. no axis label entered -> no axis text rendered, no auto-generated semantic label", () => {
    const payload = makePayload({ axisLabels: null });
    const svg = buildMap2DSvg(scaled, points, { axisLabels: payload.meta.axisLabels ? { positiveX: payload.meta.axisLabels } : null });
    // Only the fixed methodology footer text should appear — no axis annotation at all.
    expect(svg).not.toContain('text-anchor="end" font-size="11"');
  });

  it("D. quadrant labels (single researcher string) appear in the quadrant SVG and quadrant standalone HTML", () => {
    const payload = makePayload({ quadrantLabels: QUADRANT_XSS });
    const svg = buildMap2DSvg(scaled, points, { showQuadrantLines: true, quadrantCaption: payload.meta.quadrantLabels });
    expect(svg).not.toContain("<b>QUADRANT</b>");
    expect(svg).toContain("&lt;b&gt;QUADRANT&lt;/b&gt;");
    const html = buildQuadrantStandaloneHtml(payload, svg, false);
    expect(html).toContain("&lt;b&gt;QUADRANT&lt;/b&gt;");
  });

  it("E. no quadrant labels entered -> no custom caption rendered; deterministic Q1..Q4 zero-policy geometry is unaffected (see quadrant.test.ts)", () => {
    const payload = makePayload({ quadrantLabels: null });
    const svg = buildMap2DSvg(scaled, points, { showQuadrantLines: true, quadrantCaption: payload.meta.quadrantLabels });
    // quadrant lines still render (showQuadrantLines), just no caption text.
    expect(svg).toContain("stroke-dasharray");
    expect(svg).not.toContain('x="12" y="20"');
  });

  it("F. notes appear in README.txt and the standalone HTML's interpretation-metadata section", () => {
    const payload = makePayload({ notes: "NOTES_EXPORT_TEXT", interpretationStatus: "DRAFT", interpretationVersion: 1 });
    const readme = buildReadmeText(payload);
    expect(readme).toContain("NOTES_EXPORT_TEXT");
    const svg = buildMap2DSvg(scaled, points, {});
    const html = buildStandaloneHtml(payload, svg, true, null);
    expect(html).toContain("NOTES_EXPORT_TEXT");
  });

  it("G. XSS markers in axis/quadrant/notes never become executable markup anywhere they are exported", () => {
    const payload = makePayload({ axisLabels: AXIS_XSS, quadrantLabels: QUADRANT_XSS, notes: NOTES_XSS });
    const svg2d = buildMap2DSvg(scaled, points, { axisLabels: { positiveX: payload.meta.axisLabels! } });
    const svgQuadrant = buildMap2DSvg(scaled, points, { showQuadrantLines: true, quadrantCaption: payload.meta.quadrantLabels });
    const html2d = buildStandaloneHtml(payload, svg2d, false, null);
    const htmlQuadrant = buildQuadrantStandaloneHtml(payload, svgQuadrant, false);
    const csvFiles = buildCsvFiles(payload);
    const metaCsv = csvFiles.find((f) => f.filename === "01_run_metadata.csv")!;

    // SVG/HTML are markup-rendering targets — the marker must never survive as a live tag there.
    for (const artifact of [svg2d, svgQuadrant, html2d, htmlQuadrant]) {
      expect(artifact.toLowerCase()).not.toContain("<script>alert");
    }
    // README.txt and CSV are plain-text artifacts, never parsed as markup by
    // anything — containing the literal string as inert text is correct,
    // not a leak (nothing ever executes a .txt or .csv file as HTML/SVG).
    const readme = buildReadmeText(payload);
    expect(readme).toContain(NOTES_XSS);
    const parsed = parseCsv(metaCsv.content);
    const notesRow = parsed.find((r) => r[0] === "interpretation_notes");
    expect(notesRow?.[1]).toBe(NOTES_XSS);
  });

  function makeMinimalExportPayloadInputs(interpretationStatus: string) {
    const inputSnapshot = {
      snapshotVersion: 1,
      scope: "KR",
      summary: { statementCount: 1, nKr: 1, nJp: 0, nTotal: 1, includedParticipantCount: 1, excludedNullCountry: 0, excludedInvalid: 0, excludedIncomplete: 0 },
      statements: [{ id: "s1", order: 0, textKo: "stmt", textJa: null, jaStatus: "UNWRITTEN" }],
      numeric: { similarityCountMatrix: [[0]], similarityProportionMatrix: [[0]], dissimilarityMatrix: [[0]], weightMatrix: [[1]] },
    };
    const parametersSnapshot = { analysisParameters: {}, provenance: { validationBaselineSha: "baseline" } };
    return {
      projectSlug: "test-slug",
      run: {
        id: "run1",
        scope: "KR",
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        finishedAt: new Date("2026-01-01T00:00:10.000Z"),
        includedParticipantCount: 1,
        nKr: 1,
        nJp: 0,
        statementCount: 1,
        algorithmVersion: "1.0.0",
        engineSourceCommitSha: "a".repeat(40),
        parameterHash: "ph",
        numericDataHash: "ndh",
        statementStructureHash: "ssh",
        statementContentHashKo: "kch",
        statementContentHashJa: "jch",
        primaryMapDimension: 2,
        wardSourceDimension: 2,
        linkageMethod: "ward",
        executionStatus: "COMPLETED",
        wardStatus: "COMPLETED",
        wardLinkageSnapshot: null,
        inputSnapshot: JSON.stringify(inputSnapshot),
        parametersSnapshot: JSON.stringify(parametersSnapshot),
      },
      dimensions: [],
      exportLanguage: "ko" as const,
      interpretation: {
        version: 1,
        status: interpretationStatus,
        selectedClusterCount: 2,
        axisLabels: "LATEST_AXIS",
        quadrantLabels: "LATEST_QUADRANT",
        notes: "LATEST_NOTES",
      },
      interpretationLabels: [],
    };
  }

  it("H. DRAFT interpretation's latest axis/quadrant/notes values pass through into the export payload", () => {
    const payload = buildExportPayload(makeMinimalExportPayloadInputs("DRAFT"));
    expect(payload.meta.axisLabels).toBe("LATEST_AXIS");
    expect(payload.meta.quadrantLabels).toBe("LATEST_QUADRANT");
    expect(payload.meta.notes).toBe("LATEST_NOTES");
    expect(payload.meta.interpretationStatus).toBe("DRAFT");
  });

  it("I. FINALIZED interpretation's latest axis/quadrant/notes values pass through into the export payload — same snapshot, no stale mixing", () => {
    const payload = buildExportPayload(makeMinimalExportPayloadInputs("FINALIZED"));
    expect(payload.meta.axisLabels).toBe("LATEST_AXIS");
    expect(payload.meta.quadrantLabels).toBe("LATEST_QUADRANT");
    expect(payload.meta.notes).toBe("LATEST_NOTES");
    expect(payload.meta.interpretationStatus).toBe("FINALIZED");
  });
});
