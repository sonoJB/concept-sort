#!/usr/bin/env node
/**
 * One-off, idempotent clean-up: stores the phone numbers of Korean participants
 * (SortSession.countryCode = 'KR') in the standard form 010-0000-0000.
 *
 *   node scripts/backup/normalize-kr-phones.mjs            # DRY RUN: counts and masked patterns only, writes nothing
 *   node scripts/backup/normalize-kr-phones.mjs --apply    # performs the change
 *
 * Safety properties (all enforced in code, see the integration tests):
 *   - Only SortSession.phoneNumber of KR rows can change. Japanese rows (last-4
 *     fragments), participant names and every other column/table are
 *     fingerprinted before and after INSIDE the transaction and must be identical.
 *   - Values are changed only when koreanPhone.mjs says it is unambiguous.
 *     Empty / unclear values are left exactly as they are and counted separately.
 *   - A verified backup of the exact pre-change state is created first; if the
 *     data differs from that backup at the moment of writing, nothing is written.
 *   - One transaction (BEGIN IMMEDIATE ... COMMIT): all changes or none.
 *   - Re-running is harmless: already standard values are UNCHANGED, so a second
 *     run finds 0 changes, creates no backup and no log.
 *   - Every changed row is recorded (before -> after) in an access-restricted
 *     change log that is not served by any web route. It contains personal data.
 */
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeKoreanMobile } from "../../src/lib/koreanPhone.mjs";
import { backupRootFor, contentFingerprint, createBackup, resolveDbPath } from "./auto-backup.mjs";

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const mask = (s) => String(s).replace(/[0-9]/g, "d").replace(/ /g, "_");

/** Per-table fingerprints; SortSession rows listed in `maskPhoneFor` have their phoneNumber replaced by a placeholder. */
export function tableFingerprints(db, maskPhoneFor = new Set()) {
  const tables = db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all().map((r) => r.name);
  const out = {};
  for (const t of tables) {
    const rows = db
      .prepare(`select * from "${t}"`)
      .all()
      .map((r) => {
        if (t === "SortSession" && maskPhoneFor.has(r.id)) return JSON.stringify({ ...r, phoneNumber: "<MASKED>" });
        return JSON.stringify(r);
      })
      .sort();
    out[t] = sha256(t + "\n" + rows.join("\n") + "\n");
  }
  return out;
}

/** Read-only plan. Contains personal data (before/after) — never print `changes`. */
export function planChanges(db) {
  const rows = db.prepare("select id, dataRole, countryCode, phoneNumber from SortSession where countryCode = 'KR' order by createdAt, id").all();
  const changes = [];
  const needsReview = [];
  const empty = [];
  let unchanged = 0;
  for (const r of rows) {
    const res = normalizeKoreanMobile(r.phoneNumber);
    if (res.status === "NORMALIZED") changes.push({ sessionId: r.id, dataRole: r.dataRole, countryCode: r.countryCode, before: r.phoneNumber, after: res.value, rule: res.rule });
    else if (res.status === "UNCHANGED") unchanged++;
    else if (res.status === "EMPTY") empty.push({ sessionId: r.id, dataRole: r.dataRole });
    else needsReview.push({ sessionId: r.id, dataRole: r.dataRole, maskedPattern: mask(r.phoneNumber) });
  }
  const byRule = {};
  for (const c of changes) byRule[`${c.dataRole}:${c.rule}`] = (byRule[`${c.dataRole}:${c.rule}`] ?? 0) + 1;
  return {
    krRows: rows.length,
    unchanged,
    toChange: changes.length,
    byRule,
    empty,
    needsReview,
    changes,
  };
}

/** The summary that is safe to print (no phone numbers). */
export function publicSummary(plan) {
  return {
    krRows: plan.krRows,
    alreadyStandard: plan.unchanged,
    toChange: plan.toChange,
    byDataRoleAndRule: plan.byRule,
    emptyValues: plan.empty.length,
    needsReview: plan.needsReview.length,
    needsReviewPatterns: plan.needsReview.map((r) => ({ id: r.sessionId, role: r.dataRole, pattern: r.maskedPattern })),
  };
}

export function applyNormalization({ databaseUrl = process.env.DATABASE_URL, apply = false, now = new Date(), _afterBackup } = {}) {
  const dbPath = resolveDbPath(databaseUrl);
  if (!dbPath || !fs.existsSync(dbPath)) throw new Error("database file not found");

  const ro = new DatabaseSync(dbPath, { readOnly: true });
  let plan;
  try {
    plan = planChanges(ro);
  } finally {
    ro.close();
  }
  const summary = publicSummary(plan);
  if (!apply) return { mode: "DRY_RUN", summary };
  if (plan.toChange === 0) return { mode: "APPLY_NOTHING_TO_DO", summary };

  // 1) verified backup of the exact pre-change state
  const backup = createBackup({ reason: "pre-phone-normalization", databaseUrl, now });
  if (backup.result !== "OK") throw new Error("pre-change backup failed — nothing was changed: " + backup.error);
  if (_afterBackup) _afterBackup(dbPath);

  // 2) one transaction
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 15000");
  db.exec("BEGIN IMMEDIATE");
  try {
    const liveNow = contentFingerprint(db).fingerprint;
    if (liveNow !== backup.manifest.contentFingerprint) {
      throw new Error("the database changed after the backup was taken — aborting, nothing was changed; run again");
    }
    const inTxPlan = planChanges(db);
    if (JSON.stringify(inTxPlan.changes) !== JSON.stringify(plan.changes)) throw new Error("plan changed inside the transaction — aborting");

    const ids = new Set(inTxPlan.changes.map((c) => c.sessionId));
    const preFp = tableFingerprints(db, ids);

    const update = db.prepare("update SortSession set phoneNumber = ? where id = ? and countryCode = 'KR' and phoneNumber = ?");
    for (const c of inTxPlan.changes) {
      const r = update.run(c.after, c.sessionId, c.before);
      if (Number(r.changes) !== 1) throw new Error(`unexpected update count for ${c.sessionId}`);
    }

    // everything except the planned phone values must be bit-for-bit unchanged
    const postFp = tableFingerprints(db, ids);
    for (const t of Object.keys(preFp)) {
      if (preFp[t] !== postFp[t]) throw new Error(`table ${t} changed beyond the planned phone numbers — rolling back`);
    }
    // every changed value is exactly the normalised form and is stable under re-normalisation
    for (const c of inTxPlan.changes) {
      const row = db.prepare("select phoneNumber, countryCode from SortSession where id = ?").get(c.sessionId);
      if (row.countryCode !== "KR" || row.phoneNumber !== c.after || normalizeKoreanMobile(row.phoneNumber).status !== "UNCHANGED") {
        throw new Error(`verification failed for ${c.sessionId}`);
      }
    }
    const after = planChanges(db);
    if (after.toChange !== 0) throw new Error("not idempotent after update — rolling back");

    // 3) change log (access restricted); written before COMMIT as .pending, finalised after
    const logDir = path.join(backupRootFor(dbPath), "changelog");
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const logBase = path.join(logDir, `kr-phone-normalization_${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.json`);
    if (fs.existsSync(logBase) || fs.existsSync(logBase + ".pending")) throw new Error("change log already exists — refusing to overwrite");
    const log = {
      tool: "scripts/backup/normalize-kr-phones.mjs",
      containsPersonalData: true,
      runAtUtc: now.toISOString(),
      scope: "SortSession.phoneNumber where countryCode = 'KR' (Japan rows, names and all other data untouched)",
      preBackup: { dir: backup.dir, sha256: backup.manifest.sha256, contentFingerprint: backup.manifest.contentFingerprint },
      summary: publicSummary(inTxPlan),
      perTableFingerprintBefore: preFp,
      perTableFingerprintAfter: postFp,
      changes: inTxPlan.changes,
      leftUntouched: { empty: inTxPlan.empty, needsReview: inTxPlan.needsReview },
    };
    fs.writeFileSync(logBase + ".pending", JSON.stringify(log, null, 2), { flag: "wx", mode: 0o600 });

    db.exec("COMMIT");
    fs.renameSync(logBase + ".pending", logBase);
    fs.chmodSync(logBase, 0o400);
    try {
      fs.chmodSync(logDir, 0o700);
    } catch {
      // best effort on platforms without POSIX modes
    }
    db.close();

    const verify = new DatabaseSync(dbPath, { readOnly: true });
    const integrity = verify.prepare("PRAGMA integrity_check").get().integrity_check;
    const final = planChanges(verify);
    verify.close();
    if (integrity !== "ok" || final.toChange !== 0) throw new Error("post-commit verification failed — restore from the pre-change backup " + backup.dir);
    return { mode: "APPLIED", summary: publicSummary(inTxPlan), backupDir: backup.dir, changeLog: path.basename(logBase), integrity };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already rolled back / closed
    }
    try {
      db.close();
    } catch {
      // ignore
    }
    throw err;
  }
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dbIdx = args.indexOf("--db");
  const url = dbIdx >= 0 ? `file:${path.resolve(args[dbIdx + 1])}` : process.env.DATABASE_URL;
  try {
    const out = applyNormalization({ databaseUrl: url, apply });
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.error("[normalize-kr-phones] FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
