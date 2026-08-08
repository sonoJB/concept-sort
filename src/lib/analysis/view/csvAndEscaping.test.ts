import { describe, it, expect } from "vitest";
import { parseCsv } from "@/lib/csv";
import { buildCsvFiles } from "./csvBuilders";
import { escapeXml, buildMap2DSvg, build3DSvg } from "./svgFigures";
import { buildStandaloneHtml, buildQuadrantStandaloneHtml, build3DStandaloneHtml } from "./htmlBuilder";
import { buildMapPoints2D } from "./figureModel";
import type { ExportPayload } from "./exportPayload";

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
      view3d: null,
      ...overrides,
    },
    statements: [
      { id: "s1", order: 0, text: TRICKY_TEXT, jaStatus: null },
      { id: "s2", order: 1, text: XSS_MARKER, jaStatus: null },
    ],
    numeric: { similarityCountMatrix: [[0, 1], [1, 0]], similarityProportionMatrix: [[0, 1], [1, 0]], dissimilarityMatrix: [[0, 0], [0, 0]] },
    dimensions: [
      { dimension: 2, dimensionStatus: "COMPLETED", coordinates: [[0, 0], [1, 1]], rawStress: 0.01, commonStressDistance: 0.01, commonStressQ: 0.02, converged: true, iterations: 5, bestInitIndex: 0, bestSeed: 4294967295, errorCode: null, errorMessageSafe: null },
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
