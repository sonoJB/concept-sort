import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Participant-response tables whose content must never change through a deployment or an analysis/package job.
 * Project is included because it carries the survey-closed settings (koreanEnabled / japaneseEnabled).
 */
export const RAW_TABLES = ["Project", "Statement", "SortSession", "SortGroup", "SortGroupItem"] as const;

type Row = Record<string, unknown>;
type Db = { prepare(sql: string): { all(): unknown[] }; close(): void };

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export type TableFingerprint = { rows: number; columns: string[]; tableSha256: string; columnSha256: Record<string, string> };

/**
 * Same table hash as scripts/backup (`contentFingerprint` perTable: every row JSON-serialised, sorted, joined) so the value is
 * comparable with the backup tooling, plus one hash per column (rows ordered by their JSON form) so a change can be traced to a
 * column without exposing any value. Hashes only — no row, name, phone number or id leaves this function.
 */
export function fingerprintTable(db: Db, table: string): TableFingerprint {
  const rows = db.prepare(`select * from "${table}"`).all() as Row[];
  const serialised = rows.map((r) => JSON.stringify(r)).sort();
  const columns = rows.length ? Object.keys(rows[0]) : (db.prepare(`pragma table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
  const ordered = rows.map((r) => ({ key: JSON.stringify(r), r })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const columnSha256: Record<string, string> = {};
  for (const c of columns) columnSha256[c] = sha(JSON.stringify(ordered.map((o) => o.r[c] ?? null)));
  return { rows: rows.length, columns, tableSha256: sha(table + "\n" + serialised.join("\n") + "\n"), columnSha256 };
}

export type TableComparison = {
  table: string;
  rowsA: number | null;
  rowsB: number | null;
  identical: boolean;
  sameColumns: boolean;
  differingColumns: string[];
};

export function compareFingerprints(table: string, a: TableFingerprint | null, b: TableFingerprint | null): TableComparison {
  if (!a || !b) return { table, rowsA: a?.rows ?? null, rowsB: b?.rows ?? null, identical: false, sameColumns: false, differingColumns: [] };
  const sameColumns = JSON.stringify(a.columns) === JSON.stringify(b.columns);
  const differingColumns = a.columns.filter((c) => b.columns.includes(c) && a.columnSha256[c] !== b.columnSha256[c]);
  return { table, rowsA: a.rows, rowsB: b.rows, identical: a.tableSha256 === b.tableSha256, sameColumns, differingColumns };
}

export function fingerprintTables(db: Db, tables: readonly string[] = RAW_TABLES): Record<string, TableFingerprint | null> {
  const present = new Set((db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]).map((r) => r.name));
  const out: Record<string, TableFingerprint | null> = {};
  for (const t of tables) out[t] = present.has(t) ? fingerprintTable(db, t) : null;
  return out;
}

/** A backup folder name as the backup tooling writes it; no separators, so it cannot leave the backup root. */
export const BACKUP_DIR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/;

export function backupDbFile(root: string, dir: string): string | null {
  if (!BACKUP_DIR_PATTERN.test(dir)) return null;
  const folder = path.join(root, dir);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return null;
  const f = fs.readdirSync(folder).find((n) => n.endsWith(".db"));
  return f ? path.join(folder, f) : null;
}

export function liveDbFileFromDatabaseUrl(databaseUrl: string | undefined): string | null {
  if (!databaseUrl || !databaseUrl.startsWith("file:")) return null;
  let p = databaseUrl.slice("file:".length).split("?")[0];
  if (p.startsWith("//")) p = p.slice(2);
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), "prisma", p);
}
