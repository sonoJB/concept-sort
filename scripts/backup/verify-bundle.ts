/**
 * Verifies a backup bundle by actually RESTORING it into scratch databases
 * (never the production DB) and re-deriving the research results.
 *
 *   npx tsx scripts/backup/verify-bundle.ts --bundle <dir> --scratch <empty dir>
 *
 * Separately reports:
 *   A. backup FILE integrity  — every file's SHA-256 against SHA256SUMS.txt / MANIFEST.json
 *   B. RESTORE verification   — restoring the .db and (independently) the JSON export, then
 *                               table counts, row-level fingerprints, relations, raw-data
 *                               queries, and regenerating the three official matrices through
 *                               the application's own (Prisma-based) code path.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "../../src/generated/prisma/client";
import { buildCooccurrenceMatrix } from "../../src/lib/similarity";
import { readXlsx } from "../../src/lib/officialMatrix/readXlsx";
import {
  buildOfficialMatrix,
  OFFICIAL_SCOPES,
  type OfficialScope,
  type OfficialSessionInput,
  type OfficialStatement,
} from "../../src/lib/officialMatrix/build";
import { restoreFromJson } from "./restore-from-json";
import { contentFingerprint, openReadOnly, parseArgs, sha256File, tableColumns, userTables, walkFiles } from "./lib";
import { formatKst, DIAGONAL_N_SHEET_NAME } from "../../src/lib/officialMatrix/workbook";
import { comparePreservation } from "./verify-preservation";

const args = parseArgs(process.argv.slice(2));
const bundle = path.resolve(args["bundle"] ?? "");
const scratch = path.resolve(args["scratch"] ?? "");
if (!args["bundle"] || !args["scratch"]) throw new Error("usage: --bundle <dir> --scratch <dir>");
fs.mkdirSync(scratch, { recursive: true });
if (fs.readdirSync(scratch).length) throw new Error("--scratch must be an empty directory");

type Check = { section: "A" | "B" | "C" | "D"; name: string; pass: boolean; detail: string };
const checks: Check[] = [];
const check = (section: Check["section"], name: string, pass: boolean, detail = "") => {
  checks.push({ section, name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} [${section}] ${name}${detail ? " — " + detail : ""}`);
};

const manifest = JSON.parse(fs.readFileSync(path.join(bundle, "MANIFEST.json"), "utf8"));
const capturedAt = new Date(manifest.dataSnapshot.capturedAtUtc);

// ------------------------------------------------------------ A. file checksums
{
  const sums = new Map<string, string>();
  for (const line of fs.readFileSync(path.join(bundle, "SHA256SUMS.txt"), "utf8").trim().split("\n")) {
    const [hash, ...rest] = line.split("  ");
    sums.set(rest.join("  "), hash);
  }
  const actualFiles = walkFiles(bundle).filter((f) => f !== "SHA256SUMS.txt" && f !== "VERIFICATION_REPORT.md" && f !== "verification.json");
  let bad = 0;
  for (const f of actualFiles) {
    const expected = sums.get(f);
    if (!expected || expected !== sha256File(path.join(bundle, f))) {
      bad++;
      console.log("  checksum mismatch/missing in SHA256SUMS:", f);
    }
  }
  const missing = [...sums.keys()].filter((f) => f !== "VERIFICATION_REPORT.md" && f !== "verification.json" && !actualFiles.includes(f));
  check("A", "SHA256SUMS.txt matches every file in the bundle", bad === 0 && missing.length === 0, `${actualFiles.length} files, ${bad} mismatches, ${missing.length} listed-but-missing`);

  let manifestBad = 0;
  for (const f of manifest.files) {
    if (sha256File(path.join(bundle, f.path)) !== f.sha256 || fs.statSync(path.join(bundle, f.path)).size !== f.bytes) manifestBad++;
  }
  check("A", "MANIFEST.json file list (sha256 + size) matches", manifestBad === 0, `${manifest.files.length} entries, ${manifestBad} mismatches`);
}

// ------------------------------------------------------------ helpers
const dbRel = manifest.files.find((f: { role: string }) => f.role === "RESTORABLE_DB").path as string;

async function loadViaPrisma(dbFile: string) {
  const prisma = new PrismaClient({ datasourceUrl: "file:" + dbFile.replace(/\\/g, "/") });
  try {
    // Same queries as the production route (src/app/api/projects/[slug]/official-matrix/route.ts).
    const [statementRows, sessionRows] = await prisma.$transaction([
      prisma.statement.findMany({ orderBy: { order: "asc" } }),
      prisma.sortSession.findMany({ include: { groups: { include: { items: true } } } }),
    ]);
    const counts = {
      Project: await prisma.project.count(),
      Statement: await prisma.statement.count(),
      SortSession: await prisma.sortSession.count(),
      SortGroup: await prisma.sortGroup.count(),
      SortGroupItem: await prisma.sortGroupItem.count(),
      AnalysisRun: await prisma.analysisRun.count(),
      AnalysisRunDimension: await prisma.analysisRunDimension.count(),
    };
    const byRoleCountry = await prisma.sortSession.groupBy({ by: ["dataRole", "countryCode"], _count: { _all: true } });
    const project = await prisma.project.findFirstOrThrow();
    const statements: OfficialStatement[] = statementRows.map((s) => ({ id: s.id, order: s.order, textKo: s.text, textJa: s.textJa, jaStatus: s.jaStatus }));
    const sessions: OfficialSessionInput[] = sessionRows.map((s) => ({
      id: s.id,
      countryCode: s.countryCode,
      dataRole: s.dataRole,
      createdAt: s.createdAt,
      groups: s.groups.map((g) => g.items.map((i) => i.statementId)),
    }));
    return { prisma, statements, sessions, counts, byRoleCountry, project };
  } catch (e) {
    await prisma.$disconnect();
    throw e;
  }
}

function matricesFromBundle() {
  const out: Record<string, { count: number[][] | null; diag: number[][] | null; sheetNames: string[]; prop: number[][] | null; n: number | string | null; fileName: string }> = {};
  for (const f of manifest.files.filter((x: { role: string }) => x.role === "OFFICIAL_MATRIX")) {
    const sheets = readXlsx(new Uint8Array(fs.readFileSync(path.join(bundle, f.path))));
    const meta = sheets.find((s) => s.name === "메타데이터")!.rows;
    const scopeCell = meta.find((r) => r[0] === "국가 범위")![1] as string;
    const scope = scopeCell.startsWith("전체") ? "ALL" : scopeCell === "한국" ? "KR" : "JP";
    const grab = (name: string) => {
      const rows = sheets.find((s) => s.name === name)!.rows;
      return rows.length > 2 && typeof rows[1][1] === "number" ? rows.slice(1).map((r) => r.slice(1) as number[]) : null;
    };
    out[scope] = {
      count: grab("빈도행렬"),
      diag: sheets.some((s) => s.name === DIAGONAL_N_SHEET_NAME) ? grab(DIAGONAL_N_SHEET_NAME) : null,
      sheetNames: sheets.map((s) => s.name),
      prop: grab("비율행렬"),
      n: meta.find((r) => r[0] === "이 파일의 유효 N (국가 범위 내)")![1],
      fileName: path.basename(f.path),
    };
  }
  return out;
}

/** Independent re-implementation straight from raw SQL (shares no code with the app) — used only to cross-check. */
function rawRecount(dbFile: string, scope: OfficialScope) {
  const db = openReadOnly(dbFile);
  const st = (db.prepare('select id from Statement order by "order"').all() as { id: string }[]).map((r) => r.id);
  const idx = new Map(st.map((id, i) => [id, i]));
  const sessions = db
    .prepare("select id, countryCode from SortSession where dataRole = 'MAIN' and createdAt <= ?")
    .all(capturedAt.getTime()) as { id: string; countryCode: string | null }[];
  const count = Array.from({ length: st.length }, () => new Array(st.length).fill(0));
  let n = 0;
  for (const s of sessions) {
    if (s.countryCode !== "KR" && s.countryCode !== "JP") continue;
    if (scope !== "ALL" && s.countryCode !== scope) continue;
    const items = db
      .prepare("select g.id gid, i.statementId sid from SortGroup g join SortGroupItem i on i.groupId = g.id where g.sortSessionId = ?")
      .all(s.id) as { gid: string; sid: string }[];
    const seen = new Set(items.map((i) => i.sid));
    if (items.length !== st.length || seen.size !== st.length || ![...seen].every((x) => idx.has(x))) continue; // incomplete/dup/invalid
    n++;
    const groupOf = new Map(items.map((i) => [i.sid, i.gid]));
    for (let a = 0; a < st.length; a++) for (let b = a + 1; b < st.length; b++) if (groupOf.get(st[a]) === groupOf.get(st[b])) { count[a][b]++; count[b][a]++; }
  }
  db.close();
  return { n, count };
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const tableFpExceptToken = (db: DatabaseSync) => {
  const { perTable, counts } = contentFingerprint(db);
  // Project fingerprint is computed again without the secret column so DB-restore and JSON-restore are comparable.
  const rows = (db.prepare('select * from "Project"').all() as Record<string, unknown>[])
    .map((r) => { const { adminToken, ...rest } = r; void adminToken; return JSON.stringify(rest); }).sort();
  return { perTable: { ...perTable, Project: "Project\n" + rows.join("\n") }, counts };
};

async function verifyRestored(tag: string, dbFile: string) {
  const raw = openReadOnly(dbFile);
  const integrity = (raw.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
  check("B", `[${tag}] SQLite integrity_check`, integrity === "ok", integrity);
  const fk = raw.prepare("PRAGMA foreign_key_check").all();
  check("B", `[${tag}] foreign_key_check (no orphan rows)`, fk.length === 0, `${fk.length} violations`);
  const counts = contentFingerprint(raw).counts;
  const migCounts = { ...counts }; delete migCounts["_prisma_migrations"];
  const expCounts = { ...manifest.tableCounts }; delete expCounts["_prisma_migrations"];
  check("B", `[${tag}] per-table row counts equal the manifest`, eq(migCounts, expCounts), JSON.stringify(migCounts));
  const mig = (raw.prepare("select migration_name from _prisma_migrations order by migration_name").all() as { migration_name: string }[]).map((r) => r.migration_name);
  check("B", `[${tag}] migration history equals the backed-up schema version`, eq(mig, [...manifest.versions.appliedMigrations].sort()), `${mig.length} migrations, last ${mig.at(-1)}`);

  // Orphan / relationship probes in plain SQL.
  const q = (sql: string) => (raw.prepare(sql).get() as { c: number }).c;
  check("B", `[${tag}] every group belongs to a session, every item to a group and a statement`,
    q("select count(*) c from SortGroup g left join SortSession s on s.id=g.sortSessionId where s.id is null") === 0 &&
    q("select count(*) c from SortGroupItem i left join SortGroup g on g.id=i.groupId where g.id is null") === 0 &&
    q("select count(*) c from SortGroupItem i left join Statement s on s.id=i.statementId where s.id is null") === 0);
  check("B", `[${tag}] every MAIN session places all statements exactly once`,
    q(`select count(*) c from SortSession s where s.dataRole='MAIN' and (
        (select count(*) from SortGroupItem i join SortGroup g on g.id=i.groupId where g.sortSessionId=s.id) != (select count(*) from Statement) or
        (select count(distinct i.statementId) from SortGroupItem i join SortGroup g on g.id=i.groupId where g.sortSessionId=s.id) != (select count(*) from Statement))`) === 0);
  raw.close();

  // Raw-data lookups through the application's ORM.
  const loaded = await loadViaPrisma(dbFile);
  const expRC: Record<string, number> = manifest.submissionsByDataRoleAndCountry;
  const gotRC = Object.fromEntries(loaded.byRoleCountry.map((r) => [`${r.dataRole}/${r.countryCode ?? "NULL"}`, r._count._all]));
  check("B", `[${tag}] raw-data query via Prisma: submissions by dataRole/country`, eq(Object.entries(gotRC).sort(), Object.entries(expRC).sort()), JSON.stringify(gotRC));
  check("B", `[${tag}] raw-data query via Prisma: project identity`, loaded.project.slug === manifest.study.slug && loaded.project.title === manifest.study.title, `${loaded.project.title} (${loaded.project.slug})`);
  check("B", `[${tag}] raw-data query via Prisma: statements 47 with KO+JA text`, loaded.statements.length === manifest.study.statementCount && loaded.statements.every((s) => s.textKo && s.textJa));

  // Regenerate the three official matrices through the app code path and compare with the bundled files.
  const fromBundle = matricesFromBundle();
  const regenerated: Record<string, ReturnType<typeof buildOfficialMatrix>> = {};
  for (const scope of OFFICIAL_SCOPES) {
    const r = buildOfficialMatrix({ projectKey: loaded.project.slug, scope, statements: loaded.statements, sessions: loaded.sessions, asOf: capturedAt });
    regenerated[scope] = r;
    const b = fromBundle[scope];
    check("B", `[${tag}] regenerated ${scope} frequency matrix == bundled file`, eq(r.countMatrix, b.count), `N=${r.nTotal}`);
    check("B", `[${tag}] regenerated ${scope} proportion matrix == bundled file`, eq(r.proportionMatrix, b.prop));
    check("B", `[${tag}] regenerated ${scope} N == bundled file`, r.nTotal === Number(b.n));
    const independent = rawRecount(dbFile, scope);
    check("B", `[${tag}] ${scope} frequency matrix == independent raw-SQL recount`, eq(r.countMatrix, independent.count) && r.nTotal === independent.n, `independent N=${independent.n}`);
  }
  check("B", `[${tag}] source fingerprint equal across ALL/KR/JP`, new Set(OFFICIAL_SCOPES.map((s) => regenerated[s].sourceFingerprint)).size === 1);
  check("B", `[${tag}] fingerprints equal the manifest`, OFFICIAL_SCOPES.every((s) => regenerated[s].scopeFingerprint === manifest.officialMainStudy.fingerprints[s]) && regenerated.ALL.sourceFingerprint === manifest.officialMainStudy.fingerprints.source);
  await loaded.prisma.$disconnect();
  return regenerated;
}

(async () => {
  // ---------------- B1. restore the .db file into scratch
  const dbRestore = path.join(scratch, "restored-from-db", path.basename(dbRel));
  fs.mkdirSync(path.dirname(dbRestore), { recursive: true });
  fs.copyFileSync(path.join(bundle, dbRel), dbRestore);
  fs.chmodSync(dbRestore, 0o666);
  const reg1 = await verifyRestored("DB-file restore", dbRestore);
  {
    const orig = openReadOnly(path.join(bundle, dbRel));
    const restored = openReadOnly(dbRestore);
    const a = contentFingerprint(orig).fingerprint;
    const b = contentFingerprint(restored).fingerprint;
    check("B", "[DB-file restore] content fingerprint of restored copy == backed-up file == manifest", a === b && a === manifest.contentFingerprintSha256, a.slice(0, 16) + "…");
    orig.close(); restored.close();
  }

  // ---------------- B2. restore from JSON (no .db) into a fresh migrated DB
  const jsonRestore = path.join(scratch, "restored-from-json", "restored.db");
  restoreFromJson({ jsonDir: path.join(bundle, "export/json"), out: jsonRestore });
  const reg2 = await verifyRestored("JSON restore", jsonRestore);
  {
    const orig = openReadOnly(path.join(bundle, dbRel));
    const restored = openReadOnly(jsonRestore);
    const fa = tableFpExceptToken(orig);
    const fb = tableFpExceptToken(restored);
    const diffTables = Object.keys(fa.perTable).filter((t) => t !== "_prisma_migrations" && fa.perTable[t] !== fb.perTable[t]);
    check("B", "[JSON restore] every data table is row-for-row identical to the original (Project compared without the admin token)", diffTables.length === 0, diffTables.length ? "differs: " + diffTables.join(",") : `${Object.keys(fa.perTable).length - 1} tables identical`);
    orig.close(); restored.close();
  }
  check("B", "matrices regenerated from DB-restore and JSON-restore are identical", OFFICIAL_SCOPES.every((s) => eq(reg1[s].countMatrix, reg2[s].countMatrix) && eq(reg1[s].proportionMatrix, reg2[s].proportionMatrix)));

  // ---------------- B2b. JSON restore: the NEW admin credentials work, the old ones do not (no secret is printed)
  {
    const newToken = fs.readFileSync(jsonRestore + ".admin-token.txt", "utf8").trim();
    const orig = openReadOnly(path.join(bundle, dbRel));
    const oldToken = (orig.prepare("select adminToken from Project").get() as { adminToken: string }).adminToken;
    orig.close();
    process.env.DATABASE_URL = "file:" + jsonRestore.split(path.sep).join("/");
    const { prisma } = await import("../../src/lib/db");
    const route = await import("../../src/app/api/projects/[slug]/official-matrix/route");
    const { NextRequest } = await import("next/server");
    const slug = manifest.study.slug as string;
    const call = (token: string | null) =>
      route.GET(
        new NextRequest(`http://localhost/api/projects/${slug}/official-matrix?scope=ALL&format=json`, { headers: token ? { "x-admin-token": token } : {} }),
        { params: Promise.resolve({ slug }) }
      );
    const okRes = await call(newToken);
    const okBody = okRes.status === 200 ? await okRes.json() : null;
    check("B", "[JSON restore] the newly issued admin token opens the admin API of the restored database", okRes.status === 200 && okBody?.nTotal === reg2.ALL.nTotal, `HTTP ${okRes.status}, N=${okBody?.nTotal}`);
    check("B", "[JSON restore] the pre-restore admin token and a missing token are rejected", (await call(oldToken)).status === 403 && (await call(null)).status === 403);
    await prisma.$disconnect();
  }

  // ---------------- C. the diagonal-N sheet and the per-sheet definitions
  {
    const fb = matricesFromBundle();
    const expectN: Record<string, number> = {};
    for (const part of (args["expect-n"] ?? "").split(",").filter(Boolean)) {
      const [k, v] = part.split("=");
      expectN[k] = Number(v);
    }
    const required = ["메타데이터", "빈도행렬", DIAGONAL_N_SHEET_NAME, "비율행렬", "진술문대응표", "참여자(비식별)", "제외내역"];
    for (const scope of OFFICIAL_SCOPES) {
      const b = fb[scope];
      const n = reg1[scope].nTotal;
      const size = reg1[scope].statements.length;
      check("C", `[${scope}] all existing sheets are kept and the new sheet ${DIAGONAL_N_SHEET_NAME} is present`, required.every((s) => b.sheetNames.includes(s)), b.sheetNames.join(" | "));
      const diag = b.diag;
      check("C", `[${scope}] the diagonal sheet is ${size}x${size}`, !!diag && diag.length === size && diag.every((r) => r.length === size));
      check("C", `[${scope}] every one of the ${size} diagonal cells equals the scope's actual valid N (${n})`, !!diag && diag.every((r, i) => r[i] === n));
      let off = !!diag && !!b.count;
      let zeroDiag = !!b.count;
      for (let i = 0; i < size && diag && b.count; i++) for (let j = 0; j < size; j++) {
        if (i !== j && diag[i][j] !== b.count[i][j]) off = false;
        if (i === j && b.count[i][j] !== 0) zeroDiag = false;
      }
      check("C", `[${scope}] off-diagonal cells equal the existing 빈도행렬 sheet in every cell`, off);
      check("C", `[${scope}] the existing 빈도행렬 sheet keeps its zero diagonal`, zeroDiag);
      check("C", `[${scope}] diagonal sheet equals the engine's frequency matrix with the diagonal replaced by N`, !!diag && eq(diag, reg1[scope].countMatrix!.map((r, i) => r.map((v, j) => (i === j ? n : v)))));
      if (expectN[scope] !== undefined) check("C", `[${scope}] valid N equals the confirmed value ${expectN[scope]}`, n === expectN[scope], `observed ${n}`);
      const sheets = readXlsx(new Uint8Array(fs.readFileSync(path.join(bundle, manifest.files.find((x: { path: string }) => x.path.endsWith(b.fileName)).path))));
      const metaText = JSON.stringify(sheets.find((s) => s.name === "메타데이터")!.rows);
      check("C", `[${scope}] the metadata defines the diagonal of each sheet separately`, ["시트 '빈도행렬'", "시트 '비율행렬'", `시트 '${DIAGONAL_N_SHEET_NAME}'`].every((s) => metaText.includes(s)));
      const hdr = (name: string) => sheets.find((s) => s.name === name)!.rows[0];
      check("C", `[${scope}] row/column statement ids and order are identical across the frequency, diagonal and proportion sheets`, eq(hdr("빈도행렬"), hdr(DIAGONAL_N_SHEET_NAME)) && eq(hdr("빈도행렬"), hdr("비율행렬")));
    }
    const a = fb.ALL.diag, k = fb.KR.diag, j = fb.JP.diag;
    let sumOk = !!a && !!k && !!j;
    for (let x = 0; sumOk && x < a!.length; x++) for (let y = 0; y < a![x].length; y++) if (a![x][y] !== k![x][y] + j![x][y]) sumOk = false;
    check("C", "diagonal sheets: ALL = KR + JP in every cell including the diagonal", sumOk);
    check("C", "all three files use the same statement ids in the same order", eq(reg1.KR.statements.map((s) => s.id), reg1.ALL.statements.map((s) => s.id)) && eq(reg1.JP.statements.map((s) => s.id), reg1.ALL.statements.map((s) => s.id)));
  }

  // ---------------- D. preservation against a baseline snapshot (only if given)
  if (args["baseline-db"] && args["changelog"]) {
    const log = JSON.parse(fs.readFileSync(path.resolve(args["changelog"]), "utf8")) as { changes: { sessionId: string; before: string; after: string; rule: string }[] };
    const before = openReadOnly(path.resolve(args["baseline-db"]));
    const after = openReadOnly(path.join(bundle, dbRel));
    const res = comparePreservation(before, after, log.changes);
    before.close();
    after.close();
    for (const c of res.checks) check("D", c.name, c.pass, c.detail);
  }

  // ---------------- B3. definitional identities on the regenerated matrices
  {
    const { ALL, KR, JP } = reg1;
    check("B", "valid N: ALL = KR + JP", ALL.nTotal === KR.nTotal + JP.nTotal, `${ALL.nTotal} = ${KR.nTotal} + ${JP.nTotal}`);
    let cellsOk = true, denomOk = true, symOk = true, diagOk = true, rangeOk = true;
    const n = ALL.statements.length;
    check("B", `matrix size is ${n}x${n} and equals the study's statement count`, n === manifest.study.statementCount && ALL.countMatrix!.length === n && ALL.countMatrix!.every((r) => r.length === n));
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (ALL.countMatrix![i][j] !== KR.countMatrix![i][j] + JP.countMatrix![i][j]) cellsOk = false;
      if (i !== j) {
        if (Math.abs(ALL.proportionMatrix![i][j] - ALL.countMatrix![i][j] / ALL.nTotal) > 1e-12) denomOk = false;
        if (Math.abs(KR.proportionMatrix![i][j] - KR.countMatrix![i][j] / KR.nTotal) > 1e-12) denomOk = false;
        if (Math.abs(JP.proportionMatrix![i][j] - JP.countMatrix![i][j] / JP.nTotal) > 1e-12) denomOk = false;
      } else if (ALL.countMatrix![i][j] !== 0 || ALL.proportionMatrix![i][j] !== 0) diagOk = false;
      if (ALL.countMatrix![i][j] !== ALL.countMatrix![j][i]) symOk = false;
      if (ALL.countMatrix![i][j] < 0 || ALL.countMatrix![i][j] > ALL.nTotal || ALL.proportionMatrix![i][j] < 0 || ALL.proportionMatrix![i][j] > 1) rangeOk = false;
    }
    check("B", "every ALL frequency cell = KR cell + JP cell", cellsOk);
    check("B", "proportion = frequency ÷ that scope's own valid N (ALL is not the mean of KR/JP)", denomOk);
    check("B", "matrices are symmetric", symOk);
    check("B", "diagonal is 0 as defined", diagOk);
    check("B", "values within [0, N] / [0, 1]", rangeOk);
    check("B", "statement ids and order identical across ALL/KR/JP", eq(KR.statements.map((s) => s.id), ALL.statements.map((s) => s.id)) && eq(JP.statements.map((s) => s.id), ALL.statements.map((s) => s.id)));
    check("B", "no pilot / test / incomplete session is in any official file", ALL.included.length === ALL.nTotal && ALL.exclusionCounts.NOT_MAIN_ROLE === manifest.submissionsByDataRoleAndCountry["PILOT/KR"] + manifest.submissionsByDataRoleAndCountry["PILOT/JP"], JSON.stringify(ALL.exclusionCounts));
  }

  // ---------------- legacy comparison (reported, not asserted as equal)
  const legacyNotes: string[] = [];
  {
    const loaded = await loadViaPrisma(dbRestore);
    const mainSessions = loaded.sessions.filter((s) => s.dataRole === "MAIN");
    const ids = loaded.statements.map((s) => s.id);
    const legacy = buildCooccurrenceMatrix(ids, mainSessions.map((s) => ({ groups: s.groups.map((g) => ({ statementIds: g })) })));
    const off = reg1.ALL.countMatrix!;
    let offDiff = 0, diagDiff = 0;
    for (let i = 0; i < ids.length; i++) for (let j = 0; j < ids.length; j++) {
      if (i === j) { if (legacy[i][j] !== off[i][j]) diagDiff++; }
      else if (legacy[i][j] !== off[i][j]) offDiff++;
    }
    legacyNotes.push(`기존 /matrix(MAIN) 방식: 국가·완결성 필터 없이 MAIN ${mainSessions.length}건 전부 집계, 대각선=각 진술문이 어떤 묶음에든 들어간 횟수(=${legacy[0][0]})`);
    legacyNotes.push(`새 공식 ALL: 유효 N=${reg1.ALL.nTotal}, 대각선=0 (분석 엔진 기준)`);
    legacyNotes.push(`비교 결과 — 대각선 칸 차이: ${diagDiff}개 / 대각선 외 칸 차이: ${offDiff}개`);
    check("B", "legacy MAIN matrix vs new ALL: off-diagonal cells identical on current data (differences only in diagonal definition)", offDiff === 0, legacyNotes.slice(-1)[0]);
    await loaded.prisma.$disconnect();
  }

  // ---------------- report
  const failed = checks.filter((c) => !c.pass);
  const section = (s: "A" | "B" | "C" | "D") => checks.filter((c) => c.section === s);
  const row = (label: string, s: "A" | "B" | "C" | "D") =>
    section(s).length === 0 ? "" : `| ${label} | ${section(s).every((c) => c.pass) ? "**성공**" : "**실패**"} (${section(s).filter((c) => c.pass).length}/${section(s).length}) |`;
  const md = [
    "# 백업 검증 보고서 (VERIFICATION_REPORT)",
    "",
    `- 검증 실행: ${formatKst(new Date())}`,
    `- 대상 묶음: \`${path.basename(bundle)}\` (원자료 기준 시점 ${formatKst(capturedAt)})`,
    `- 검증 방식: 운영 DB가 아닌 **임시 폴더**에 복원하여 수행. 복원본은 검증 후 삭제됨`,
    "",
    "## 결과 요약",
    "",
    `| 구분 | 결과 |`,
    `|---|---|`,
    row("A. 백업 파일 생성·무결성(체크섬)", "A"),
    row("B. 복원 검증(DB 복원 · JSON 복원 · 행렬 재생성 · 새 관리자 인증)", "B"),
    row("C. 대각선N 시트·시트별 정의·세 파일 일관성", "C"),
    row("D. 정비 전 스냅샷 대비 보존(허용된 전화번호 변경 외 변경 없음)", "D"),
    `| 전체 | ${failed.length === 0 ? "**성공**" : "**실패**"} (${checks.length - failed.length}/${checks.length}) |`,
    "",
    "> 'A 백업 파일 생성 성공'과 'B 복원 검증 성공'은 별개입니다. A는 파일이 온전하다는 뜻이고, B는 그 파일로 실제 DB를 되살리고 결과를 다시 만들 수 있음을 확인한 것입니다.",
    "",
    "## 상세",
    "",
    ...checks.map((c) => `- ${c.pass ? "✅" : "❌"} **[${c.section}]** ${c.name}${c.detail ? ` — ${c.detail}` : ""}`),
    "",
    "## 기존 본조사 행렬(`/matrix`)과 새 공식 행렬의 차이",
    "",
    ...legacyNotes.map((l) => `- ${l}`),
    "",
    "차이의 원인: (1) 기존은 국가 구분이 없고 미완료·중복 응답도 걸러내지 않으며 대각선에 배치 횟수를 넣음, (2) 새 공식 행렬은 분석 엔진과 같은 기준(완결·유효 응답만, 국가 미지정 제외, 대각선 0)으로 국가별 3종을 같은 스냅샷에서 생성. 현재 자료에는 미완료·국가 미지정·중복 응답이 없어 대각선 외 값은 동일합니다.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(bundle, "VERIFICATION_REPORT.md"), md);
  fs.writeFileSync(path.join(bundle, "verification.json"), JSON.stringify({ at: new Date().toISOString(), checks, legacyNotes }, null, 1));

  // refresh SHA256SUMS to include the report files
  const sums = walkFiles(bundle).filter((f) => f !== "SHA256SUMS.txt");
  fs.writeFileSync(path.join(bundle, "SHA256SUMS.txt"), sums.map((f) => `${sha256File(path.join(bundle, f))}  ${f}`).join("\n") + "\n");

  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
void tableColumns; void userTables;
