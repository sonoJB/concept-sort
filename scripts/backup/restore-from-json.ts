/**
 * Rebuilds a brand-new SQLite database from the JSON export in a backup
 * bundle (use this only when the .db file itself is unavailable).
 *
 *   npx tsx scripts/backup/restore-from-json.ts \
 *     --json-dir <bundle>/export/json --out <new database file>
 *
 * 1. The empty schema is created by the project's own `prisma migrate deploy`
 *    (so the migration history table is correct).
 * 2. Rows are inserted parents-first with foreign keys ON.
 * 3. The admin token is NOT in the JSON export (it is a secret), so a NEW
 *    random token is generated and written to `<out>.admin-token.txt` — it is
 *    never printed. Participant links (slug) are unchanged; the admin URL
 *    changes to use the new token.
 *
 * Never point --out at the production database file.
 */
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RESTORE_ORDER, parseArgs, type Row } from "./lib";

export function restoreFromJson(opts: { jsonDir: string; out: string }) {
  const { jsonDir, out } = opts;
  if (fs.existsSync(out)) throw new Error("refusing to overwrite existing file: " + out);

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const repoRoot = path.resolve(__dirname, "../..");
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  execFileSync(npx, ["prisma", "migrate", "deploy"], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: "file:" + path.resolve(out).split(path.sep).join("/") },
    stdio: ["ignore", "ignore", "inherit"],
    shell: process.platform === "win32",
  });

  const db = new DatabaseSync(out);
  db.exec("PRAGMA foreign_keys = ON;");

  const tokenFile = out + ".admin-token.txt";
  const newAdminToken = crypto.randomBytes(18).toString("base64url");
  const inserted: Record<string, number> = {};

  db.exec("BEGIN");
  try {
    for (const table of RESTORE_ORDER) {
      const file = path.join(jsonDir, `${table}.json`);
      if (!fs.existsSync(file)) throw new Error("missing export file: " + file);
      const rows = JSON.parse(fs.readFileSync(file, "utf8")) as Row[];
      const cols = (db.prepare(`pragma table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
      const stmt = db.prepare(
        `insert into "${table}" (${cols.map((c) => `"${c}"`).join(",")}) values (${cols.map(() => "?").join(",")})`
      );
      for (const row of rows) {
        const withToken: Row = table === "Project" ? { ...row, adminToken: newAdminToken } : row;
        stmt.run(...cols.map((c) => (withToken[c] === undefined ? null : withToken[c])));
      }
      inserted[table] = rows.length;
    }
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length) throw new Error("foreign key violations after restore: " + JSON.stringify(violations.slice(0, 3)));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    db.close();
    fs.rmSync(out, { force: true });
    throw err;
  }
  db.close();
  fs.writeFileSync(tokenFile, newAdminToken + "\n", { flag: "wx", mode: 0o600 });
  return { restoredTo: out, inserted, adminTokenFile: tokenFile };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (!args["json-dir"] || !args["out"]) throw new Error("usage: --json-dir <dir> --out <new.db>");
  if (/prod/i.test(path.basename(args["out"]))) {
    console.warn("[restore] note: output file name contains 'prod' — make sure this is a NEW file, not the live database.");
  }
  console.log(JSON.stringify(restoreFromJson({ jsonDir: args["json-dir"], out: args["out"] }), null, 1));
}
