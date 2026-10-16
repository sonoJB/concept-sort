import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import {
  buildOfficialMatrix,
  anonymousParticipantId,
  type OfficialSessionInput,
  type OfficialStatement,
  type OfficialScope,
} from "./build";
import {
  buildOfficialMatrixWorkbook,
  officialMatrixFileName,
  officialMatrixAsciiFileName,
  statementCode,
} from "./workbook";
import { buildXlsx, columnLetter, sanitizeSheetName } from "./xlsx";
import { withDiagonalN } from "./build";
import { DIAGONAL_N_SHEET_NAME } from "./workbook";
import { readXlsx } from "./readXlsx";

const statements: OfficialStatement[] = ["a", "b", "c", "d"].map((id, i) => ({
  id,
  order: i,
  textKo: `한국어-${id}`,
  textJa: `日本語-${id}`,
  jaStatus: "APPROVED",
}));

let seq = 0;
function sess(
  countryCode: string | null,
  groups: string[][],
  opts: { dataRole?: string; createdAt?: string } = {}
): OfficialSessionInput {
  seq++;
  return {
    id: `sess-${seq}`,
    countryCode,
    dataRole: opts.dataRole ?? "MAIN",
    createdAt: new Date(opts.createdAt ?? `2026-10-0${(seq % 9) + 1}T00:00:00.000Z`),
    groups,
  };
}

// Complete valid sorts over statements a-d.
const SORT_AB_CD = [["a", "b"], ["c", "d"]];
const SORT_ABC_D = [["a", "b", "c"], ["d"]];
const SORT_AC_BD = [["a", "c"], ["b", "d"]];

function build(scope: OfficialScope, sessions: OfficialSessionInput[], asOf?: Date) {
  return buildOfficialMatrix({ projectKey: "p", scope, statements, sessions, asOf });
}

describe("official 본조사 matrix — definitions", () => {
  // KR N=3, JP N=2 (deliberately different sample sizes).
  const kr = [sess("KR", SORT_AB_CD), sess("KR", SORT_AB_CD), sess("KR", SORT_ABC_D)];
  const jp = [sess("JP", SORT_AC_BD), sess("JP", SORT_AB_CD)];
  const all = [...kr, ...jp];

  it("valid N: ALL = KR + JP", () => {
    const a = build("ALL", all);
    const k = build("KR", all);
    const j = build("JP", all);
    expect(k.nTotal).toBe(3);
    expect(j.nTotal).toBe(2);
    expect(a.nTotal).toBe(k.nTotal + j.nTotal);
    expect(a.nKr).toBe(3);
    expect(a.nJp).toBe(2);
  });

  it("every ALL frequency cell equals KR + JP frequency", () => {
    const a = build("ALL", all).countMatrix!;
    const k = build("KR", all).countMatrix!;
    const j = build("JP", all).countMatrix!;
    for (let i = 0; i < 4; i++) for (let c = 0; c < 4; c++) expect(a[i][c]).toBe(k[i][c] + j[i][c]);
  });

  it("frequency counts same-group co-placement; diagonal is 0; symmetric", () => {
    const k = build("KR", all).countMatrix!;
    // a-b together in all three KR sorts; a-c only in SORT_ABC_D; c-d together in two.
    expect(k[0][1]).toBe(3);
    expect(k[0][2]).toBe(1);
    expect(k[2][3]).toBe(2);
    for (let i = 0; i < 4; i++) {
      expect(k[i][i]).toBe(0);
      for (let c = 0; c < 4; c++) expect(k[i][c]).toBe(k[c][i]);
    }
  });

  it("proportion denominator is that scope's own valid N; ALL is NOT the mean of country proportions", () => {
    const a = build("ALL", all);
    const k = build("KR", all);
    const j = build("JP", all);
    for (let i = 0; i < 4; i++) {
      for (let c = 0; c < 4; c++) {
        if (i === c) continue;
        expect(a.proportionMatrix![i][c]).toBeCloseTo(a.countMatrix![i][c] / 5, 12);
        expect(k.proportionMatrix![i][c]).toBeCloseTo(k.countMatrix![i][c] / 3, 12);
        expect(j.proportionMatrix![i][c]).toBeCloseTo(j.countMatrix![i][c] / 2, 12);
      }
    }
    // a-b: KR 3/3 = 1, JP 1/2 = 0.5 -> simple mean 0.75, pooled 4/5 = 0.8
    expect((k.proportionMatrix![0][1] + j.proportionMatrix![0][1]) / 2).toBeCloseTo(0.75, 12);
    expect(a.proportionMatrix![0][1]).toBeCloseTo(0.8, 12);
  });

  it("values stay within range", () => {
    const a = build("ALL", all);
    for (const row of a.countMatrix!) for (const v of row) expect(v >= 0 && v <= 5).toBe(true);
    for (const row of a.proportionMatrix!) for (const v of row) expect(v >= 0 && v <= 1).toBe(true);
  });

  it("matrices are indexed by Statement.order regardless of input array order", () => {
    const shuffled = [...statements].reverse();
    const a = buildOfficialMatrix({ projectKey: "p", scope: "ALL", statements: shuffled, sessions: all });
    expect(a.statements.map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
    expect(a.countMatrix).toEqual(build("ALL", all).countMatrix);
  });

  it("all three scopes share statement ids/order/size and the same source fingerprint", () => {
    const a = build("ALL", all);
    const k = build("KR", all);
    const j = build("JP", all);
    expect(k.statements.map((s) => s.id)).toEqual(a.statements.map((s) => s.id));
    expect(j.statements.map((s) => s.id)).toEqual(a.statements.map((s) => s.id));
    expect(k.sourceFingerprint).toBe(a.sourceFingerprint);
    expect(j.sourceFingerprint).toBe(a.sourceFingerprint);
    expect(new Set([a.scopeFingerprint, k.scopeFingerprint, j.scopeFingerprint]).size).toBe(3);
  });

  it("participant pseudonyms are stable across files and never the DB id", () => {
    const a = build("ALL", all);
    const k = build("KR", all);
    const kIds = new Set(k.included.map((p) => p.anonId));
    for (const id of kIds) expect(a.included.some((p) => p.anonId === id)).toBe(true);
    for (const p of a.included) {
      expect(p.anonId).toMatch(/^MP-[0-9a-f]{10}$/);
      expect(p.anonId).not.toContain("sess-");
    }
    expect(anonymousParticipantId("x")).toBe(anonymousParticipantId("x"));
  });
});

describe("official 본조사 matrix — population gate and boundary cases", () => {
  it("pilot / non-MAIN sessions never enter any scope", () => {
    const sessions = [
      sess("KR", SORT_AB_CD),
      sess("KR", SORT_AC_BD, { dataRole: "PILOT" }),
      sess("JP", SORT_AB_CD, { dataRole: "PILOT" }),
      sess("JP", SORT_AB_CD, { dataRole: "TEST" }),
      sess("JP", SORT_AB_CD, { dataRole: "main" }), // wrong case is not MAIN
    ];
    for (const scope of ["ALL", "KR", "JP"] as const) {
      const r = build(scope, sessions);
      expect(r.nTotal).toBe(scope === "JP" ? 0 : 1);
    }
    expect(build("ALL", sessions).exclusionCounts.NOT_MAIN_ROLE).toBe(4);
  });

  it("country null is excluded from every scope, listed, and never assigned to KR/JP", () => {
    const s = sess(null, SORT_AB_CD);
    const sessions = [sess("KR", SORT_AB_CD), sess("JP", SORT_AB_CD), s, sess("XX", SORT_AB_CD)];
    for (const scope of ["ALL", "KR", "JP"] as const) {
      const r = build(scope, sessions);
      expect(r.exclusionCounts.NULL_COUNTRY).toBe(2);
      expect(r.excludedMainDetail.filter((d) => d.reason === "NULL_COUNTRY")).toHaveLength(2);
    }
    expect(build("ALL", sessions).nTotal).toBe(2);
    expect(build("KR", sessions).nTotal).toBe(1);
    expect(build("JP", sessions).nTotal).toBe(1);
  });

  it("incomplete / duplicate-statement / invalid-statement sorts are excluded with the right reason, not repaired", () => {
    const sessions = [
      sess("KR", SORT_AB_CD),
      sess("KR", [["a", "b"], ["c"]]), // d missing
      sess("KR", [["a", "b"], ["b", "c", "d"]]), // b twice
      sess("KR", [["a", "b"], ["c", "d", "zzz"]]), // foreign statement
    ];
    const r = build("KR", sessions);
    expect(r.nTotal).toBe(1);
    expect(r.exclusionCounts.INCOMPLETE).toBe(1);
    expect(r.exclusionCounts.DUPLICATE_STATEMENT).toBe(1);
    expect(r.exclusionCounts.INVALID_STATEMENT).toBe(1);
    // a missing answer is never treated as "different group = 0": the sort is simply not counted.
    expect(r.countMatrix![0][1]).toBe(1);
  });

  it("out-of-scope country is counted but is not a data-quality listing", () => {
    const r = build("KR", [sess("KR", SORT_AB_CD), sess("JP", SORT_AB_CD)]);
    expect(r.exclusionCounts.OUT_OF_SCOPE_COUNTRY).toBe(1);
    expect(r.excludedMainDetail).toHaveLength(0);
  });

  it("zero-participant scope has NO matrix (not a zero matrix) and is flagged", () => {
    const r = build("JP", [sess("KR", SORT_AB_CD)]);
    expect(r.nTotal).toBe(0);
    expect(r.countMatrix).toBeNull();
    expect(r.proportionMatrix).toBeNull();
    const rows = readXlsx(buildOfficialMatrixWorkbook(r, ctx(r)));
    const count = rows.find((s) => s.name === "빈도행렬")!;
    expect(JSON.stringify(count.rows)).toContain("대상 본조사 완료자 없음");
    expect(count.rows.flat().some((v) => typeof v === "number")).toBe(false);
    const meta = rows.find((s) => s.name === "메타데이터")!;
    expect(JSON.stringify(meta.rows)).toContain("대상 본조사 완료자 없음");
  });

  it("asOf cuts off later submissions identically for every scope", () => {
    const early = sess("KR", SORT_AB_CD, { createdAt: "2026-10-01T00:00:00.000Z" });
    const late = sess("JP", SORT_AB_CD, { createdAt: "2026-10-09T00:00:00.000Z" });
    const asOf = new Date("2026-10-05T00:00:00.000Z");
    expect(build("ALL", [early, late], asOf).nTotal).toBe(1);
    expect(build("ALL", [early, late], asOf).exclusionCounts.AFTER_AS_OF).toBe(1);
    expect(build("ALL", [early, late]).nTotal).toBe(2);
  });
});

function ctx(r: ReturnType<typeof build>) {
  return {
    project: { id: "proj-id", slug: "slug", title: "사이버폭력의 특징" },
    generatedAt: new Date("2026-10-16T12:05:00.000Z"),
    codeVersion: "test",
    snapshotAll: { nKr: r.nKr, nJp: r.nJp, nTotal: r.nTotal },
  };
}

describe("official 본조사 workbook", () => {
  const sessions = [sess("KR", SORT_AB_CD), sess("JP", SORT_AC_BD), sess("JP", SORT_AB_CD)];

  it("contains the required sheets and round-trips the exact matrices", () => {
    const r = build("ALL", sessions);
    const sheets = readXlsx(buildOfficialMatrixWorkbook(r, ctx(r)));
    expect(sheets.map((s) => s.name)).toEqual([
      "메타데이터",
      "빈도행렬",
      "분석용_유사성빈도_대각선N",
      "비율행렬",
      "진술문대응표",
      "참여자(비식별)",
      "제외내역",
    ]);
    const counts = sheets[1].rows.slice(1).map((row) => row.slice(1));
    expect(counts).toEqual(r.countMatrix);
    const props = sheets[3].rows.slice(1).map((row) => row.slice(1));
    expect(props).toEqual(r.proportionMatrix);
    // Row/column IDs are separated from the numeric block.
    expect(sheets[1].rows[0][0]).toBe("진술문ID");
    expect(sheets[1].rows[0].slice(1)).toEqual(["S01", "S02", "S03", "S04"]);
    expect(sheets[1].rows[1][0]).toBe("S01");
  });

  it("statement mapping keeps common id / order / KO / JA", () => {
    const r = build("KR", sessions);
    const map = readXlsx(buildOfficialMatrixWorkbook(r, ctx(r))).find((s) => s.name === "진술문대응표")!;
    expect(map.rows[1]).toEqual(["S01", 0, "a", "한국어-a", "日本語-a", "APPROVED"]);
    expect(map.rows).toHaveLength(5);
  });

  it("metadata records scope, phase, N, formulas, diagonal, snapshot and code version", () => {
    const r = build("JP", sessions);
    const text = JSON.stringify(readXlsx(buildOfficialMatrixWorkbook(r, ctx(r))).find((s) => s.name === "메타데이터")!.rows);
    for (const needle of ["일본", "dataRole = MAIN", "종류/대각선", "계산식", "코드 버전", r.sourceFingerprint, r.scopeFingerprint, "사이버폭력의 특징"]) {
      expect(text).toContain(needle);
    }
  });

  it("never contains names, phone numbers, tokens, or raw session ids", () => {
    const r = build("ALL", sessions);
    const bytes = buildOfficialMatrixWorkbook(r, ctx(r));
    const files = unzipSync(bytes);
    const all = Object.values(files).map((f) => strFromU8(f)).join("\n");
    for (const forbidden of ["participantName", "phoneNumber", "adminToken", "sess-"]) {
      expect(all).not.toContain(forbidden);
    }
  });

  it("file names use 본조사 consistently and a KST timestamp", () => {
    const d = new Date("2026-10-16T12:05:00.000Z"); // 21:05 KST
    expect(officialMatrixFileName("ALL", d)).toBe("본조사_유사성행렬_전체_KR-JP_20261016_2105.xlsx");
    expect(officialMatrixFileName("KR", d)).toBe("본조사_유사성행렬_한국_KR_20261016_2105.xlsx");
    expect(officialMatrixFileName("JP", d)).toBe("본조사_유사성행렬_일본_JP_20261016_2105.xlsx");
    expect(officialMatrixAsciiFileName("JP", d)).toMatch(/^[\x20-\x7e]+$/);
    expect(statementCode(0, 47)).toBe("S01");
    expect(statementCode(46, 47)).toBe("S47");
  });
});

describe("diagonal-N frequency sheet", () => {
  const kr = [sess("KR", SORT_AB_CD), sess("KR", SORT_AB_CD), sess("KR", SORT_ABC_D)];
  const jp = [sess("JP", SORT_AC_BD), sess("JP", SORT_AB_CD)];
  const all = [...kr, ...jp];
  const sheetMatrix = (r: ReturnType<typeof build>, name: string) =>
    readXlsx(buildOfficialMatrixWorkbook(r, ctx(r))).find((s) => s.name === name)!.rows.slice(1).map((row) => row.slice(1)) as number[][];

  it("every diagonal cell equals that scope's actual valid N (not hard-coded)", () => {
    for (const [scope, n] of [["ALL", 5], ["KR", 3], ["JP", 2]] as const) {
      const r = build(scope, all);
      const m = sheetMatrix(r, DIAGONAL_N_SHEET_NAME);
      expect(r.nTotal).toBe(n);
      for (let i = 0; i < 4; i++) expect(m[i][i]).toBe(n);
    }
  });

  it("off-diagonal cells and size are identical to the existing 빈도행렬 sheet", () => {
    const r = build("ALL", all);
    const base = sheetMatrix(r, "빈도행렬");
    const diag = sheetMatrix(r, DIAGONAL_N_SHEET_NAME);
    expect(diag).toHaveLength(base.length);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (i !== j) expect(diag[i][j]).toBe(base[i][j]);
    // the original 빈도행렬 sheet keeps its zero diagonal
    for (let i = 0; i < 4; i++) expect(base[i][i]).toBe(0);
  });

  it("ALL = KR + JP in every cell including the diagonal", () => {
    const a = sheetMatrix(build("ALL", all), DIAGONAL_N_SHEET_NAME);
    const k = sheetMatrix(build("KR", all), DIAGONAL_N_SHEET_NAME);
    const j = sheetMatrix(build("JP", all), DIAGONAL_N_SHEET_NAME);
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) expect(a[x][y]).toBe(k[x][y] + j[x][y]);
  });

  it("is a separate matrix: the engine's matrix object is not modified", () => {
    const r = build("ALL", all);
    const before = JSON.stringify(r.countMatrix);
    const d = withDiagonalN(r.countMatrix!, r.nTotal);
    expect(JSON.stringify(r.countMatrix)).toBe(before);
    expect(d).not.toBe(r.countMatrix);
    expect(r.countMatrix![0][0]).toBe(0);
    expect(r.proportionMatrix![0][0]).toBe(0);
  });

  it("metadata defines the diagonal of each sheet separately", () => {
    const r = build("KR", all);
    const text = JSON.stringify(readXlsx(buildOfficialMatrixWorkbook(r, ctx(r))).find((s) => s.name === "메타데이터")!.rows);
    for (const needle of ["시트 '빈도행렬'", "시트 '비율행렬'", `시트 '${DIAGONAL_N_SHEET_NAME}'`, "대각선 = 0", "= 이 파일의 유효 N(3)"]) {
      expect(text).toContain(needle);
    }
  });

  it("an empty scope gets a notice, not a matrix of zeros", () => {
    const r = build("JP", [sess("KR", SORT_AB_CD)]);
    const sheet = readXlsx(buildOfficialMatrixWorkbook(r, ctx(r))).find((s) => s.name === DIAGONAL_N_SHEET_NAME)!;
    expect(JSON.stringify(sheet.rows)).toContain("대상 본조사 완료자 없음");
    expect(sheet.rows.flat().some((v) => typeof v === "number")).toBe(false);
  });
});

describe("xlsx writer", () => {
  it("writes strings inline (no formulas), strips illegal XML chars, keeps leading zeros", () => {
    const bytes = buildXlsx([
      { name: "t", rows: [["=1+1", "0123", "a\u0001b", "<&>"], [1.5, 0, null]] },
    ]);
    const sheet = readXlsx(bytes)[0];
    expect(sheet.rows[0]).toEqual(["=1+1", "0123", "ab", "<&>"]);
    expect(sheet.rows[1][0]).toBe(1.5);
    const xml = strFromU8(unzipSync(bytes)["xl/worksheets/sheet1.xml"]);
    expect(xml).not.toContain("<f>");
  });

  it("rejects non-finite numbers instead of writing garbage", () => {
    expect(() => buildXlsx([{ name: "t", rows: [[NaN]] }])).toThrow();
  });

  it("column letters and sheet-name sanitising", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
    expect(columnLetter(701)).toBe("ZZ");
    expect(columnLetter(702)).toBe("AAA");
    const used = new Set<string>();
    expect(sanitizeSheetName("a/b:c", used)).toBe("a_b_c");
    expect(sanitizeSheetName("a/b:c", used)).toBe("a_b_c_2");
    expect(sanitizeSheetName("x".repeat(40), new Set())).toHaveLength(31);
  });
});
