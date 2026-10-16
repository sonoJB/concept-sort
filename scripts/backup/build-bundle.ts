/**
 * Builds the researcher-facing backup bundle from a consistent SQLite snapshot
 * of the production database.
 *
 *   npx tsx scripts/backup/build-bundle.ts \
 *     --db <snapshot.db> --out <bundle dir> --label survey-complete \
 *     --captured-at <ISO time the snapshot was taken> --git-commit <sha> \
 *     --env-names <json file with variable NAMES only>
 *
 * The snapshot is opened READ-ONLY and never modified. Output files are
 * created write-once (an existing file aborts the run).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { toCsvWithBom } from "../../src/lib/csv";
import { buildXlsx, type XlsxCell } from "../../src/lib/officialMatrix/xlsx";
import {
  anonymousParticipantId,
  buildOfficialMatrix,
  OFFICIAL_SCOPES,
  type OfficialSessionInput,
  type OfficialStatement,
} from "../../src/lib/officialMatrix/build";
import {
  buildOfficialMatrixWorkbook,
  formatKst,
  officialMatrixFileName,
  statementCode,
  OFFICIAL_MATRIX_SPEC_VERSION,
} from "../../src/lib/officialMatrix/workbook";
import { assertDictionaryCovers, dictionaryMarkdown } from "./dataDictionary";
import {
  contentFingerprint,
  ensureDir,
  openReadOnly,
  parseArgs,
  readTable,
  sha256File,
  tableColumns,
  userTables,
  walkFiles,
  writeNew,
  type Row,
} from "./lib";

const args = parseArgs(process.argv.slice(2));
const need = (k: string) => {
  if (!args[k]) throw new Error(`missing --${k}`);
  return args[k];
};

const dbPath = need("db");
const outDir = need("out");
const label = args["label"] ?? "backup";
const capturedAt = new Date(need("captured-at"));
const gitCommit = args["git-commit"] ?? "unknown";
const deployedCommit = args["deployed-commit"] ?? gitCommit;
const envNamesFile = args["env-names"];
if (Number.isNaN(capturedAt.getTime())) throw new Error("bad --captured-at");

const generatedAt = new Date();
const KST = (ms: number | null) => (ms === null || ms === undefined ? "" : formatKst(new Date(ms)));
const NFKC = (s: string) => s.normalize("NFKC");
const strOrNull = (v: unknown) => (v === null || v === undefined ? "" : String(v));

// ---------------------------------------------------------------- read DB
const db = openReadOnly(dbPath);
const integrity = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
if (integrity !== "ok") throw new Error("snapshot integrity_check failed: " + integrity);
if (fkViolations.length) throw new Error("snapshot has foreign key violations: " + JSON.stringify(fkViolations.slice(0, 3)));

const tables = userTables(db);
const columnsByTable: Record<string, string[]> = {};
for (const t of tables) columnsByTable[t] = tableColumns(db, t).map((c) => c.name);
assertDictionaryCovers(columnsByTable);

const data: Record<string, Row[]> = {};
for (const t of tables) data[t] = readTable(db, t);
const fp = contentFingerprint(db);
db.close();

const project = data.Project[0];
if (data.Project.length !== 1) throw new Error("expected exactly one project in the production DB, found " + data.Project.length);

// -------------------------------------------------- official 본조사 matrices
const statements: OfficialStatement[] = data.Statement.map((s) => ({
  id: s.id as string,
  order: s.order as number,
  textKo: s.text as string,
  textJa: (s.textJa as string | null) ?? null,
  jaStatus: s.jaStatus as string,
})).sort((a, b) => a.order - b.order);
const code = new Map(statements.map((s, i) => [s.id, statementCode(i, statements.length)]));

const groupsBySession = new Map<string, { id: string; label: string; statementIds: string[] }[]>();
const itemsByGroup = new Map<string, string[]>();
for (const it of data.SortGroupItem) {
  const arr = itemsByGroup.get(it.groupId as string) ?? [];
  arr.push(it.statementId as string);
  itemsByGroup.set(it.groupId as string, arr);
}
for (const g of data.SortGroup) {
  const arr = groupsBySession.get(g.sortSessionId as string) ?? [];
  arr.push({ id: g.id as string, label: (g.label as string) ?? "", statementIds: itemsByGroup.get(g.id as string) ?? [] });
  groupsBySession.set(g.sortSessionId as string, arr);
}
const orderOf = new Map(statements.map((s) => [s.id, s.order]));
const minOrder = (ids: string[]) => Math.min(...ids.map((i) => orderOf.get(i) ?? 1e9));

const sessionsInput: OfficialSessionInput[] = data.SortSession.map((s) => ({
  id: s.id as string,
  countryCode: (s.countryCode as string | null) ?? null,
  dataRole: s.dataRole as string,
  createdAt: new Date(s.createdAt as number),
  groups: (groupsBySession.get(s.id as string) ?? []).map((g) => g.statementIds),
}));

const results = Object.fromEntries(
  OFFICIAL_SCOPES.map((scope) => [
    scope,
    buildOfficialMatrix({
      projectKey: project.slug as string,
      scope,
      statements,
      sessions: sessionsInput,
      asOf: capturedAt,
    }),
  ])
) as Record<(typeof OFFICIAL_SCOPES)[number], ReturnType<typeof buildOfficialMatrix>>;

// -------------------------------------------------------------- write files
ensureDir(outDir);
const writtenNotes: Record<string, { role: string; sensitive: boolean; description: string }> = {};
const note = (rel: string, role: string, sensitive: boolean, description: string) => {
  writtenNotes[rel] = { role, sensitive, description };
};

// 1) DB copy (restorable). Contains PII and the admin token -> sensitive.
const dbRel = `db/${path.basename(dbPath)}`;
ensureDir(path.join(outDir, "db"));
if (path.resolve(dbPath) !== path.resolve(outDir, dbRel)) {
  fs.copyFileSync(dbPath, path.join(outDir, dbRel), fs.constants.COPYFILE_EXCL);
}
note(dbRel, "RESTORABLE_DB", true, "복원 가능한 SQLite 전체 백업(VACUUM INTO 일관 스냅샷). 개인정보와 관리자 토큰 포함");

// 2) JSON + CSV per table (admin token removed from Project)
const exportRows = (t: string): Row[] =>
  t === "Project" ? data[t].map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "adminToken"))) : data[t];
for (const t of tables) {
  const rows = exportRows(t);
  const sensitive = t === "SortSession";
  writeNew(path.join(outDir, `export/json/${t}.json`), JSON.stringify(rows, null, 1));
  note(`export/json/${t}.json`, "RAW_JSON", sensitive, `${t} 원자료(JSON, 값 형식 보존: 문자열은 문자열 그대로)`);
  const cols = Object.keys(rows[0] ?? Object.fromEntries(columnsByTable[t].map((c) => [c, null])));
  const csv = toCsvWithBom([cols, ...rows.map((r) => cols.map((c) => strOrNull(r[c])))]);
  writeNew(path.join(outDir, `export/csv/${t}.csv`), csv);
  note(`export/csv/${t}.csv`, "RAW_CSV", sensitive, `${t} 원자료(CSV, UTF-8 BOM). NULL과 빈 문자열은 구분되지 않음. Excel에서 열면 앞자리 0이 사라질 수 있으니 JSON/xlsx를 기준으로 사용`);
}

// 3) Researcher workbook
const sessionsSorted = [...data.SortSession].sort((a, b) => (a.createdAt as number) - (b.createdAt as number));
const includedAll = new Map(results.ALL.included.map((p) => [p.anonId, true]));
const excludedDetail = new Map(results.ALL.excludedMainDetail.map((d) => [d.anonId, d.reason]));

const participantRows: XlsxCell[][] = [
  [
    "번호(제출순)",
    "자료구분",
    "dataRole(원문)",
    "국가",
    "제출시각(UTC)",
    "제출시각(KST)",
    "비식별ID",
    "공식 본조사 행렬 포함",
    "제외 사유",
    "이름(원문·수정 없음)",
    "[파생] 이름 NFKC 정규화",
    "전화번호(한국=전체 / 일본=끝4자리·원문)",
    "[파생] 일본: 이름과 전화 끝4자리 일치",
    "성별",
    "연령",
    "학교급",
    "학년",
    "동의",
    "묶음 수",
    "내부 session ID",
  ].map((v) => ({ v, bold: true })),
];
sessionsSorted.forEach((s, i) => {
  const id = s.id as string;
  const anon = anonymousParticipantId(id);
  const name = s.participantName as string;
  const phone = s.phoneNumber as string;
  const country = (s.countryCode as string | null) ?? "";
  let match = "해당 없음(한국/파일럿)";
  if (country === "JP" && s.dataRole === "MAIN") {
    match = /^[0-9０-９]{4}$/.test(name) ? (NFKC(name) === phone ? "일치" : "불일치") : "비교 불가(4자리 숫자 아님)";
  }
  const isMain = s.dataRole === "MAIN";
  participantRows.push([
    i + 1,
    isMain ? "본조사" : "파일럿",
    s.dataRole as string,
    country,
    new Date(s.createdAt as number).toISOString(),
    KST(s.createdAt as number),
    anon,
    includedAll.has(anon) ? "Y" : "N",
    includedAll.has(anon) ? "" : isMain ? (excludedDetail.get(anon) ?? "") : "NOT_MAIN_ROLE",
    name,
    NFKC(name),
    phone,
    match,
    s.gender as string,
    s.age as number,
    s.schoolLevel as string,
    s.grade as string,
    (s.consentAgreed as number) === 1 ? "동의" : "미동의",
    (groupsBySession.get(id) ?? []).length,
    id,
  ]);
});

const summaryRows: XlsxCell[][] = [["자료구분", "국가", "제출 완료 건수"].map((v) => ({ v, bold: true }))];
const tally = new Map<string, number>();
for (const s of data.SortSession) {
  const k = `${s.dataRole === "MAIN" ? "본조사" : "파일럿"}|${(s.countryCode as string | null) ?? "(없음)"}`;
  tally.set(k, (tally.get(k) ?? 0) + 1);
}
for (const [k, n] of [...tally.entries()].sort()) summaryRows.push([...k.split("|"), n]);
summaryRows.push([], [{ v: "합계", bold: true }, "", data.SortSession.length]);

const longRows: XlsxCell[][] = [
  ["비식별ID", "내부 session ID", "자료구분", "국가", "묶음 번호", "묶음 내부 ID", "묶음 이름(참가자 입력)", "진술문ID", "진술문 order"].map((v) => ({ v, bold: true })),
];
const wideHeader: XlsxCell[] = [
  { v: "비식별ID", bold: true },
  { v: "자료구분", bold: true },
  { v: "국가", bold: true },
  ...statements.map((s) => ({ v: code.get(s.id)!, bold: true })),
];
const wideRows: XlsxCell[][] = [wideHeader];
for (const s of sessionsSorted) {
  const id = s.id as string;
  const anon = anonymousParticipantId(id);
  const gs = [...(groupsBySession.get(id) ?? [])].sort((a, b) => minOrder(a.statementIds) - minOrder(b.statementIds));
  const groupNoByStatement = new Map<string, number>();
  gs.forEach((g, gi) => {
    for (const sid of g.statementIds) {
      groupNoByStatement.set(sid, gi + 1);
      longRows.push([
        anon,
        id,
        s.dataRole === "MAIN" ? "본조사" : "파일럿",
        (s.countryCode as string | null) ?? "",
        gi + 1,
        g.id,
        g.label,
        code.get(sid) ?? `(알 수 없음:${sid})`,
        orderOf.get(sid) ?? -1,
      ]);
    }
  });
  wideRows.push([
    anon,
    s.dataRole === "MAIN" ? "본조사" : "파일럿",
    (s.countryCode as string | null) ?? "",
    ...statements.map((st) => groupNoByStatement.get(st.id) ?? null),
  ]);
}

const stmtRows: XlsxCell[][] = [
  ["진술문ID", "order", "DB 진술문 ID", "한국어", "日本語", "일본어 검수상태"].map((v) => ({ v, bold: true })),
  ...statements.map((s) => [code.get(s.id)!, s.order, s.id, s.textKo, s.textJa ?? "", s.jaStatus] as XlsxCell[]),
];

const settingsRows: XlsxCell[][] = [["항목", "값"].map((v) => ({ v, bold: true }))];
for (const [k, v] of Object.entries(project)) {
  if (k === "adminToken") {
    settingsRows.push([k, "(비밀 — 이 파일에는 포함하지 않음. db/ 폴더의 DB 파일에만 존재)"]);
  } else if (/At$/.test(k) && typeof v === "number") {
    settingsRows.push([k, `${v}  (${KST(v)})`]);
  } else {
    settingsRows.push([k, strOrNull(v)]);
  }
}

const runRows: XlsxCell[][] = [
  [
    "분석 실행 ID",
    "국가 범위",
    "자료 범위(dataset)",
    "상태",
    "시작(KST)",
    "종료(KST)",
    "한국 N",
    "일본 N",
    "전체 N",
    "본조사 N",
    "파일럿 N",
    "제외-국가없음",
    "제외-미완료",
    "제외-중복·무효",
    "알고리즘 버전",
    "분석 엔진 커밋",
    "주 지도 차원",
    "Ward 차원",
    "연결 방식",
    "numericDataHash",
    "parameterHash",
  ].map((v) => ({ v, bold: true })),
  ...data.AnalysisRun.map(
    (r) =>
      [
        r.id as string,
        r.scope as string,
        r.dataset as string,
        r.executionStatus as string,
        KST(r.startedAt as number),
        KST(r.finishedAt as number | null),
        r.nKr as number,
        r.nJp as number,
        r.nTotal as number,
        r.mainCount as number,
        r.pilotCount as number,
        r.excludedNullCountry as number,
        r.excludedIncomplete as number,
        r.excludedInvalid as number,
        r.algorithmVersion as string,
        r.engineSourceCommitSha as string,
        r.primaryMapDimension as number,
        r.wardSourceDimension as number,
        r.linkageMethod as string,
        r.numericDataHash as string,
        r.parameterHash as string,
      ] as XlsxCell[]
  ),
];

const jpMain = data.SortSession.filter((s) => s.countryCode === "JP" && s.dataRole === "MAIN");
const jpFourDigit = jpMain.filter((s) => /^[0-9０-９]{4}$/.test(s.participantName as string)).length;
const jpFullWidth = jpMain.filter((s) => /^[０-９]{4}$/.test(s.participantName as string)).length;
const jpNameNote = `일본 본조사 ${jpMain.length}명 중 ${jpFourDigit}명의 '이름(원문)'이 4자리 숫자 코드입니다(전각 ${jpFullWidth}명). 앱에는 별도의 일본어 이름 저장 필드가 없으며, 전각 숫자는 입력된 원문 그대로 보존했습니다.`;

const readme: XlsxCell[][] = [
  [{ v: "연구 원자료 전체 (백업용 Excel)", bold: true }],
  ["⚠ 이 파일에는 개인정보(이름·전화번호 등)가 들어 있습니다. 공개 저장소·메일 첨부·공유 폴더에 올리지 마세요."],
  [`생성: ${formatKst(generatedAt)} · 원자료 기준 시점: ${formatKst(capturedAt)} · 연구: ${project.title} (${project.slug})`],
  [],
  [{ v: "시트 안내", bold: true }],
  [`참여자: 제출 완료 ${data.SortSession.length}건 전체(본조사+파일럿). '공식 본조사 행렬 포함' 열로 분석 대상 여부를 구분`],
  ["참여자_요약: 자료구분×국가 건수"],
  ["분류결과_묶음(long): 참여자별 묶음·진술문 연결 전체 (행 1개 = 묶음에 들어간 진술문 1개)"],
  ["분류결과_참여자x진술문: 행=참여자, 열=진술문, 값=그 참여자가 만든 묶음 번호(묶음 번호는 해당 참여자 안에서만 의미 있음)"],
  ["진술문: 공통 진술문ID(S01…)·order·한국어·일본어 대응"],
  ["연구설정: 동의서·지침·영상 링크 등 (관리자 토큰 제외)"],
  ["분석실행: 기존 분석 실행 이력 요약(상세 스냅샷은 export/json/AnalysisRun.json)"],
  [],
  [{ v: "열 해석 주의 — 일본 참가자의 '이름'", bold: true }],
  [jpNameNote],
  ["'[파생]' 표시가 붙은 열은 원문을 바꾸지 않고 비교용으로 계산한 값입니다. 원문 열이 기준 자료입니다. 일치 여부 '불일치'는 수정하지 않고 그대로 두었습니다."],
  ["이름·전화번호는 문자열입니다. 앞자리 0이 있는 값도 문자열로 저장되어 있습니다."],
];

const researcherXlsx = buildXlsx([
  { name: "안내", rows: readme, colWidths: [150] },
  { name: "참여자", rows: participantRows, colWidths: [10, 9, 10, 6, 26, 24, 16, 12, 22, 22, 22, 24, 22, 8, 6, 10, 8, 8, 8, 28], freeze: { rows: 1, cols: 0 } },
  { name: "참여자_요약", rows: summaryRows, colWidths: [12, 10, 14] },
  { name: "분류결과_묶음(long)", rows: longRows, colWidths: [16, 28, 9, 6, 8, 28, 24, 10, 10], freeze: { rows: 1, cols: 0 } },
  { name: "분류결과_참여자x진술문", rows: wideRows, colWidths: [16, 9, 6, ...statements.map(() => 5)], freeze: { rows: 1, cols: 3 } },
  { name: "진술문", rows: stmtRows, colWidths: [10, 8, 30, 60, 60, 16], freeze: { rows: 1, cols: 0 } },
  { name: "연구설정", rows: settingsRows, colWidths: [30, 120] },
  { name: "분석실행", rows: runRows, colWidths: [28, 8, 24, 11, 24, 24, 7, 7, 7, 8, 8, 10, 10, 12, 16, 42, 8, 8, 12, 66, 66], freeze: { rows: 1, cols: 1 } },
]);
writeNew(path.join(outDir, "export/연구원자료_전체.xlsx"), researcherXlsx);
note("export/연구원자료_전체.xlsx", "RESEARCHER_EXCEL", true, "연구자 열람용 Excel(참여자·분류결과·진술문·설정·분석실행). 개인정보 포함");

// 4) The three official 본조사 matrices (same snapshot, same generation time)
const snapshotAll = { nKr: results.ALL.nKr, nJp: results.ALL.nJp, nTotal: results.ALL.nTotal };
for (const scope of OFFICIAL_SCOPES) {
  const fileName = officialMatrixFileName(scope, generatedAt);
  const bytes = buildOfficialMatrixWorkbook(results[scope], {
    project: { id: project.id as string, slug: project.slug as string, title: project.title as string },
    generatedAt,
    codeVersion: gitCommit,
    snapshotAll,
  });
  writeNew(path.join(outDir, `matrices/${fileName}`), bytes);
  note(`matrices/${fileName}`, "OFFICIAL_MATRIX", false, `본조사 유사성 행렬(${scope}) — 비식별 자료`);
}

// 5) Docs
writeNew(path.join(outDir, "DATA_DICTIONARY.md"), dictionaryMarkdown());
note("DATA_DICTIONARY.md", "DOC", false, "데이터 사전");

let envNames: { name: string; railwayProvided: boolean }[] = [];
if (envNamesFile) envNames = JSON.parse(fs.readFileSync(envNamesFile, "utf8"));

const lastMig = data._prisma_migrations.map((m) => m.migration_name as string).sort().at(-1);
const byCountryRole: Record<string, number> = {};
for (const s of data.SortSession) {
  const k = `${s.dataRole}/${(s.countryCode as string | null) ?? "NULL"}`;
  byCountryRole[k] = (byCountryRole[k] ?? 0) + 1;
}

// 6) Code archive for the deployed commit
if (gitCommit !== "unknown" && args["code-archive"] !== "false") {
  const rel = `code/concept-sort_${gitCommit.slice(0, 12)}.zip`;
  ensureDir(path.join(outDir, "code"));
  execFileSync("git", ["archive", "--format=zip", "-o", path.join(outDir, rel), gitCommit], { cwd: path.resolve(__dirname, "../..") });
  note(rel, "CODE", false, `배포 커밋 ${gitCommit} 의 소스 코드(비밀값 없음). GitHub 없이도 서비스를 다시 세울 수 있음`);
}

const recoveryMd = fs.readFileSync(path.resolve(__dirname, "RECOVERY_TEMPLATE.md"), "utf8")
  .replaceAll("{{COMMIT}}", gitCommit)
  .replaceAll("{{DB_FILE}}", dbRel)
  .replaceAll("{{LABEL}}", label)
  .replaceAll("{{ENV_NAMES}}", envNames.length ? envNames.map((e) => `- \`${e.name}\`${e.railwayProvided ? " (Railway가 자동 제공)" : " (**직접 설정 필요**)"}`).join("\n") : "- (목록 없음)")
  .replaceAll("{{LAST_MIGRATION}}", lastMig ?? "?");
writeNew(path.join(outDir, "README_복구절차서.md"), recoveryMd);
note("README_복구절차서.md", "DOC", false, "장애 유형별 복구 절차서");

// 7) Manifest
const files = walkFiles(outDir).filter((f) => f !== "MANIFEST.json" && f !== "SHA256SUMS.txt");
const manifest = {
  manifestVersion: 1,
  label,
  createdAt: { utc: generatedAt.toISOString(), kst: formatKst(generatedAt), timeZoneNote: "KST/JST = UTC+9 (서머타임 없음). 파일 안의 epoch 값은 UTC 밀리초" },
  dataSnapshot: { capturedAtUtc: capturedAt.toISOString(), capturedAtKst: formatKst(capturedAt), method: "SQLite VACUUM INTO (단일 읽기 트랜잭션, 운영 DB는 읽기 전용으로만 열림)" },
  study: { title: project.title, slug: project.slug, projectId: project.id, statementCount: statements.length, koreanEnabled: project.koreanEnabled, japaneseEnabled: project.japaneseEnabled },
  versions: {
    appCommit: deployedCommit,
    bundleToolsCommit: gitCommit,
    prismaSchemaLastMigration: lastMig,
    appliedMigrations: data._prisma_migrations.map((m) => m.migration_name),
    officialMatrixSpec: OFFICIAL_MATRIX_SPEC_VERSION,
    sqliteIntegrityCheck: integrity,
    foreignKeyViolations: fkViolations.length,
  },
  tableCounts: fp.counts,
  contentFingerprintSha256: fp.fingerprint,
  perTableFingerprintSha256: fp.perTable,
  submissionsByDataRoleAndCountry: byCountryRole,
  submissionStatusNote: "SortSession은 최종 제출이 완료될 때만 생성됩니다. 임시저장·미완료 상태의 행은 DB에 존재하지 않으므로 모든 행이 '제출 완료'입니다.",
  officialMainStudy: {
    validN: { KR: results.KR.nTotal, JP: results.JP.nTotal, ALL: results.ALL.nTotal },
    exclusionCountsAll: results.ALL.exclusionCounts,
    fingerprints: { source: results.ALL.sourceFingerprint, ALL: results.ALL.scopeFingerprint, KR: results.KR.scopeFingerprint, JP: results.JP.scopeFingerprint },
  },
  environmentVariableNames: envNames,
  retentionNote: "보존기간·삭제 기준은 확인된 연구계획/IRB 기준이 없어 임의로 정하지 않았습니다. 이 백업은 자동으로 삭제되지 않습니다.",
  files: files.map((f) => ({
    path: f,
    bytes: fs.statSync(path.join(outDir, f)).size,
    sha256: sha256File(path.join(outDir, f)),
    ...(writtenNotes[f] ?? { role: "OTHER", sensitive: false, description: "" }),
  })),
};
writeNew(path.join(outDir, "MANIFEST.json"), JSON.stringify(manifest, null, 2));

// 8) Checksums over everything (except itself)
const sumFiles = walkFiles(outDir).filter((f) => f !== "SHA256SUMS.txt");
writeNew(path.join(outDir, "SHA256SUMS.txt"), sumFiles.map((f) => `${sha256File(path.join(outDir, f))}  ${f}`).join("\n") + "\n");

console.log(JSON.stringify({ outDir, files: sumFiles.length, validN: manifest.officialMainStudy.validN, fingerprint: fp.fingerprint }, null, 1));
