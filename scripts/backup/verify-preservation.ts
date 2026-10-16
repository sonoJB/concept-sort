/**
 * Row-level before/after comparison of two database snapshots, with the
 * Korean phone clean-up as the ONLY permitted change.
 *
 *   npx tsx scripts/backup/verify-preservation.ts --before <db> --after <db> --changelog <log.json> [--out <report.json>]
 *
 * Passing means:
 *   - no row was removed from any table; (new rows are reported separately)
 *   - the only modified rows are SortSession rows listed in the change log, the
 *     only modified column is phoneNumber, and before/after equal the logged values
 *   - every other column of every row — participant name, country, data role,
 *     submission time, gender/age/school, group labels, group-item links,
 *     statements, project settings, analysis results, migration history — is identical
 *   - Japanese rows' phone fragments are identical
 *   - each logged "after" value is exactly what the shared Korean normaliser produces
 *     from the logged "before" value and is stable under re-normalisation
 * It never prints phone numbers or names.
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { normalizeKoreanMobile } from "../../src/lib/koreanPhone.mjs";
import { openReadOnly, parseArgs, readTable, userTables, type Row } from "./lib";

export type PreservationCheck = { name: string; pass: boolean; detail: string };
export type PreservationResult = { checks: PreservationCheck[]; perTable: Record<string, { before: number; after: number; unchanged: number; modified: number; added: number; removed: number }>; ok: boolean };

type LogChange = { sessionId: string; before: string; after: string; rule: string };

export function comparePreservation(beforeDb: DatabaseSync, afterDb: DatabaseSync, changes: LogChange[]): PreservationResult {
  const checks: PreservationCheck[] = [];
  const add = (name: string, pass: boolean, detail = "") => checks.push({ name, pass, detail });
  const perTable: PreservationResult["perTable"] = {};

  const logById = new Map(changes.map((c) => [c.sessionId, c]));
  const tablesBefore = userTables(beforeDb);
  const tablesAfter = userTables(afterDb);
  add("same set of tables before/after", JSON.stringify(tablesBefore) === JSON.stringify(tablesAfter), tablesBefore.join(","));

  const unexpected: string[] = [];
  const modifiedLogged = new Set<string>();
  let removedTotal = 0;
  let addedTotal = 0;

  for (const t of tablesBefore) {
    const b = new Map(readTable(beforeDb, t).map((r) => [String(r.id), r]));
    const a = new Map(readTable(afterDb, t).map((r) => [String(r.id), r]));
    let unchanged = 0, modified = 0, added = 0, removed = 0;
    for (const [id, rb] of b) {
      const ra = a.get(id);
      if (!ra) {
        removed++;
        continue;
      }
      const cols = new Set([...Object.keys(rb), ...Object.keys(ra)]);
      const diff = [...cols].filter((c) => JSON.stringify(rb[c]) !== JSON.stringify(ra[c]));
      if (diff.length === 0) {
        unchanged++;
        continue;
      }
      modified++;
      const log = t === "SortSession" ? logById.get(id) : undefined;
      if (t === "SortSession" && log && diff.length === 1 && diff[0] === "phoneNumber" && rb.phoneNumber === log.before && ra.phoneNumber === log.after && rb.countryCode === "KR") {
        modifiedLogged.add(id);
      } else {
        unexpected.push(`${t}#${id.slice(-6)}: ${diff.join(",")}`);
      }
    }
    for (const id of a.keys()) if (!b.has(id)) added++;
    perTable[t] = { before: b.size, after: a.size, unchanged, modified, added, removed };
    removedTotal += removed;
    addedTotal += added;
  }

  add("no row was removed from any table", removedTotal === 0, `${removedTotal} removed`);
  add("every modified row is a logged Korean phone change (only the phoneNumber column)", unexpected.length === 0, unexpected.length ? "unexpected: " + unexpected.slice(0, 5).join("; ") : `${modifiedLogged.size} rows`);
  add("every change-log entry was applied exactly once", modifiedLogged.size === changes.length, `${modifiedLogged.size} of ${changes.length}`);
  add("no change-log entry refers to a non-Korean row", changes.every((c) => {
    const r = readTable(beforeDb, "SortSession").find((x) => x.id === c.sessionId);
    return r?.countryCode === "KR";
  }));
  add("rows added since the 'before' snapshot (reported, not a failure)", true, `${addedTotal} added`);

  // explicit invariants on the fields the study cares about
  const sb = readTable(beforeDb, "SortSession");
  const sa = new Map(readTable(afterDb, "SortSession").map((r) => [r.id, r]));
  const keep = ["participantName", "countryCode", "dataRole", "createdAt", "gender", "age", "schoolLevel", "grade", "consentAgreed", "projectId"];
  let keepOk = true;
  for (const r of sb) {
    const x = sa.get(r.id);
    if (!x) continue;
    for (const k of keep) if (JSON.stringify(r[k]) !== JSON.stringify(x[k])) keepOk = false;
  }
  add("participant name, country, study phase, submission time and demographics unchanged for every pre-existing row", keepOk);
  const jpOk = sb.filter((r) => r.countryCode === "JP").every((r) => sa.get(r.id)?.phoneNumber === r.phoneNumber);
  add("Japanese last-4 phone values identical", jpOk, `${sb.filter((r) => r.countryCode === "JP").length} rows`);
  const noCountryOk = sb.filter((r) => r.countryCode === null).every((r) => sa.get(r.id)?.phoneNumber === r.phoneNumber);
  add("rows without a country untouched", noCountryOk);

  const groupsSame = ["SortGroup", "SortGroupItem"].every((t) => perTable[t].modified === 0 && perTable[t].removed === 0 && perTable[t].added === 0);
  add("classification results (groups, group labels, group-item links) identical", groupsSame, `SortGroup ${perTable.SortGroup?.after}, SortGroupItem ${perTable.SortGroupItem?.after}`);
  add("statements, project settings, analysis runs and migration history identical", ["Statement", "Project", "AnalysisRun", "AnalysisRunDimension", "_prisma_migrations"].every((t) => perTable[t].modified === 0 && perTable[t].removed === 0));

  // the change log itself must be self-consistent with the shared normaliser
  const badLog = changes.filter((c) => {
    const n = normalizeKoreanMobile(c.before);
    return !(n.status === "NORMALIZED" && n.value === c.after && n.rule === c.rule && normalizeKoreanMobile(c.after).status === "UNCHANGED");
  });
  add("each logged 'after' is exactly the normaliser's output for the logged 'before' (and stable)", badLog.length === 0, `${changes.length} entries`);

  // final state of every Korean value
  const krAfter = readTable(afterDb, "SortSession").filter((r) => r.countryCode === "KR");
  const stats = { standard: 0, review: 0, empty: 0 };
  for (const r of krAfter) {
    const s = normalizeKoreanMobile(r.phoneNumber).status;
    if (s === "UNCHANGED") stats.standard++;
    else if (s === "EMPTY") stats.empty++;
    else stats.review++;
  }
  add("Korean phone values after: all standard, or explicitly counted as needing review/empty", stats.standard + stats.review + stats.empty === krAfter.length, `standard ${stats.standard}, needs review ${stats.review}, empty ${stats.empty} of ${krAfter.length}`);

  return { checks, perTable, ok: checks.every((c) => c.pass) };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (!args["before"] || !args["after"] || !args["changelog"]) throw new Error("usage: --before <db> --after <db> --changelog <json> [--out <json>]");
  const log = JSON.parse(fs.readFileSync(args["changelog"], "utf8")) as { changes: LogChange[] };
  const b = openReadOnly(args["before"]);
  const a = openReadOnly(args["after"]);
  const res = comparePreservation(b, a, log.changes);
  b.close();
  a.close();
  for (const c of res.checks) console.log(`${c.pass ? "PASS" : "FAIL"} ${c.name}${c.detail ? " — " + c.detail : ""}`);
  console.table(res.perTable);
  if (args["out"]) fs.writeFileSync(args["out"], JSON.stringify(res, null, 2), { flag: "wx" });
  process.exit(res.ok ? 0 : 1);
}
void (null as unknown as Row);
