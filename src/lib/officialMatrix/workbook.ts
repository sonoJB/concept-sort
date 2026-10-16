import type { ExcludedReason, OfficialMatrixResult, OfficialScope } from "./build";
import { buildXlsx, type XlsxCell, type XlsxSheet } from "./xlsx";

export const OFFICIAL_MATRIX_SPEC_VERSION = "official-matrix-v1";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function formatKst(date: Date): string {
  const k = new Date(date.getTime() + KST_OFFSET_MS);
  return `${k.getUTCFullYear()}-${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())} ${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}:${pad(k.getUTCSeconds())} KST`;
}

function kstStamp(date: Date): string {
  const k = new Date(date.getTime() + KST_OFFSET_MS);
  return `${k.getUTCFullYear()}${pad(k.getUTCMonth() + 1)}${pad(k.getUTCDate())}_${pad(k.getUTCHours())}${pad(k.getUTCMinutes())}`;
}

const SCOPE_NAME_KO: Record<OfficialScope, string> = {
  ALL: "전체(한국+일본)",
  KR: "한국",
  JP: "일본",
};

/** File-name fragment per scope, e.g. 본조사_유사성행렬_전체_KR-JP_20261016_2105.xlsx */
export function officialMatrixFileName(scope: OfficialScope, generatedAt: Date): string {
  const frag = scope === "ALL" ? "전체_KR-JP" : scope === "KR" ? "한국_KR" : "일본_JP";
  return `본조사_유사성행렬_${frag}_${kstStamp(generatedAt)}.xlsx`;
}

/** ASCII-only fallback used for the plain `filename=` parameter. */
export function officialMatrixAsciiFileName(scope: OfficialScope, generatedAt: Date): string {
  const frag = scope === "ALL" ? "ALL_KR-JP" : scope;
  return `main_study_similarity_matrix_${frag}_${kstStamp(generatedAt)}.xlsx`;
}

export function statementCode(index: number, total: number): string {
  return "S" + pad(index + 1, Math.max(2, String(total).length));
}

const REASON_LABEL: Record<ExcludedReason, string> = {
  NOT_MAIN_ROLE: "본조사 아님(파일럿 등) — 공식 행렬에서 항상 제외",
  AFTER_AS_OF: "원자료 기준 시점 이후 제출",
  NULL_COUNTRY: "국가 정보 없음 — 한국/일본으로 임의 배정하지 않음",
  OUT_OF_SCOPE_COUNTRY: "다른 국가 범위(이 파일의 범위 밖)",
  INCOMPLETE: "진술문 전체를 분류하지 않음(미완료)",
  DUPLICATE_STATEMENT: "한 진술문이 둘 이상의 묶음에 중복 배치",
  INVALID_STATEMENT: "프로젝트에 없는 진술문 포함",
};

export type OfficialWorkbookContext = {
  project: { id: string; slug: string; title: string };
  generatedAt: Date;
  codeVersion: string;
  /** Result for scope ALL computed from the same snapshot: gives every file the same "whole study" N for comparison. */
  snapshotAll: Pick<OfficialMatrixResult, "nKr" | "nJp" | "nTotal">;
};

function matrixSheet(
  name: string,
  result: OfficialMatrixResult,
  matrix: number[][] | null
): XlsxSheet {
  const total = result.statements.length;
  if (!matrix) {
    return {
      name,
      rows: [
        [{ v: "대상 본조사 완료자 없음", bold: true }],
        ["이 국가 범위에는 공식 본조사 유효 참여자가 0명이므로 행렬을 만들지 않았습니다. (0으로 채운 행렬이 아닙니다.)"],
      ],
      colWidths: [80],
    };
  }
  const codes = result.statements.map((_, i) => statementCode(i, total));
  const rows: XlsxCell[][] = [[{ v: "진술문ID", bold: true }, ...codes.map((c) => ({ v: c, bold: true }))]];
  matrix.forEach((row, i) => {
    rows.push([{ v: codes[i], bold: true }, ...row]);
  });
  return { name, rows, colWidths: [10, ...codes.map(() => 7)], freeze: { rows: 1, cols: 1 } };
}

export function buildOfficialMatrixWorkbook(result: OfficialMatrixResult, ctx: OfficialWorkbookContext): Uint8Array {
  const total = result.statements.length;
  const empty = result.nTotal === 0;
  const latestIncluded = result.included.length
    ? result.included.reduce((m, p) => (p.submittedAt > m ? p.submittedAt : m), "")
    : null;

  const meta: XlsxCell[][] = [
    [{ v: "항목", bold: true }, { v: "값", bold: true }],
    ["문서 종류", "본조사 유사성 행렬 (공식 분석용)"],
    ["명세 버전", OFFICIAL_MATRIX_SPEC_VERSION],
    ["연구명", ctx.project.title],
    ["연구 식별자(slug)", ctx.project.slug],
    ["연구 식별자(DB id)", ctx.project.id],
    ["조사 단계", "본조사 (dataRole = MAIN만 포함. 파일럿·테스트 자료는 어떤 선택 상태에서도 제외)"],
    ["국가 범위", SCOPE_NAME_KO[result.scope]],
    ["이 파일의 유효 N (국가 범위 내)", result.nTotal],
    ["본조사 전체 스냅샷 유효 N — 한국", ctx.snapshotAll.nKr],
    ["본조사 전체 스냅샷 유효 N — 일본", ctx.snapshotAll.nJp],
    ["본조사 전체 스냅샷 유효 N — 합계", ctx.snapshotAll.nTotal],
    ["진술문 수", total],
    [
      "포함 기준",
      "dataRole=MAIN, 저장된 국가 코드가 KR 또는 JP(국가 범위에 해당), 모든 진술문을 정확히 한 번씩 분류한 완결 제출(중복·미완료·무효 진술문 없음)",
    ],
    [
      "제외 기준",
      "파일럿/비본조사, 국가 코드 없음(임의 배정 안 함), 미완료, 진술문 중복 배치, 무효 진술문, 원자료 기준 시점 이후 제출. 사유별 건수는 '제외내역' 시트 참조",
    ],
    ["빈도 행렬 계산식", "빈도[i][j] = Σ(유효 참여자) 1{진술문 i와 j를 같은 묶음에 분류} (i≠j)"],
    ["비율 행렬 계산식", "비율[i][j] = 빈도[i][j] ÷ 해당 파일의 유효 N (전체 비율은 국가별 비율의 평균이 아니라 전체 참여자 기준)"],
    ["대각선 처리", "0 (자기 자신과의 쌍은 관측값이 아니며 분석 엔진 기준과 동일). 값 0/최대값은 모두 유효한 관측치"],
    ["진술문 순서", "Statement.order 오름차순. 세 파일(전체·한국·일본) 모두 동일한 진술문ID(S01…)·순서 사용"],
    ["원자료 기준 시점", result.asOf ?? "요청 시점의 최신 본조사 자료 (별도 기준 시점 미지정)"],
    ["포함된 마지막 제출 시각", latestIncluded ?? "해당 없음"],
    ["생성 시각(UTC)", ctx.generatedAt.toISOString()],
    ["생성 시각(KST)", formatKst(ctx.generatedAt)],
    ["코드 버전", ctx.codeVersion],
    ["원자료 스냅샷 지문(sha256) — 세 파일 비교용", result.sourceFingerprint],
    ["이 파일 포함 자료 지문(sha256)", result.scopeFingerprint],
    ["개인정보", "이름·전화번호·접근 토큰·DB 내부 ID는 포함하지 않음. 참여자는 비식별 ID(MP-…)로만 표기"],
  ];
  if (empty) {
    meta.splice(1, 0, [{ v: "주의", bold: true }, { v: "대상 본조사 완료자 없음 — 행렬을 생성하지 않았습니다.", bold: true }]);
  }

  const mapping: XlsxCell[][] = [
    [
      { v: "진술문ID", bold: true },
      { v: "순서(order)", bold: true },
      { v: "DB 진술문 ID", bold: true },
      { v: "한국어", bold: true },
      { v: "日本語", bold: true },
      { v: "일본어 검수상태", bold: true },
    ],
    ...result.statements.map((s, i) => [statementCode(i, total), s.order, s.id, s.textKo, s.textJa ?? "", s.jaStatus] as XlsxCell[]),
  ];

  const participants: XlsxCell[][] = [
    [
      { v: "비식별 참여자ID", bold: true },
      { v: "국가", bold: true },
      { v: "제출 시각(UTC)", bold: true },
      { v: "제출 시각(KST)", bold: true },
      { v: "묶음 수", bold: true },
    ],
    ...result.included.map(
      (p) =>
        [p.anonId, p.countryCode, p.submittedAt, formatKst(new Date(p.submittedAt)), p.groupCount] as XlsxCell[]
    ),
  ];

  const excluded: XlsxCell[][] = [
    [{ v: "제외 사유", bold: true }, { v: "건수", bold: true }],
    ...(Object.keys(result.exclusionCounts) as ExcludedReason[]).map(
      (k) => [`${REASON_LABEL[k]} [${k}]`, result.exclusionCounts[k]] as XlsxCell[]
    ),
    [],
    [{ v: "개별 목록(본조사 자료 중 데이터 품질 사유로 제외된 건)", bold: true }],
    [{ v: "비식별 참여자ID", bold: true }, { v: "사유", bold: true }, { v: "저장된 국가값", bold: true }],
    ...(result.excludedMainDetail.length > 0
      ? result.excludedMainDetail.map((d) => [d.anonId, REASON_LABEL[d.reason], d.countryCode ?? "(없음)"] as XlsxCell[])
      : ([["(없음)"]] as XlsxCell[][])),
  ];

  return buildXlsx([
    { name: "메타데이터", rows: meta, colWidths: [44, 110] },
    matrixSheet("빈도행렬", result, result.countMatrix),
    matrixSheet("비율행렬", result, result.proportionMatrix),
    { name: "진술문대응표", rows: mapping, colWidths: [10, 12, 30, 60, 60, 16], freeze: { rows: 1, cols: 0 } },
    { name: "참여자(비식별)", rows: participants, colWidths: [18, 8, 26, 24, 10], freeze: { rows: 1, cols: 0 } },
    { name: "제외내역", rows: excluded, colWidths: [80, 24, 16] },
  ]);
}
