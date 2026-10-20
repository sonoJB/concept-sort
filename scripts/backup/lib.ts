import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type Row = Record<string, string | number | null>;

export function openReadOnly(file: string): DatabaseSync {
  return new DatabaseSync(file, { readOnly: true });
}

export function userTables(db: DatabaseSync): string[] {
  return (
    db
      .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

export function readTable(db: DatabaseSync, table: string): Row[] {
  return db.prepare(`select * from "${table}"`).all() as Row[];
}

export function tableColumns(db: DatabaseSync, table: string): { name: string; type: string; pk: number }[] {
  return db.prepare(`pragma table_info("${table}")`).all() as { name: string; type: string; pk: number }[];
}

/** Tables in foreign-key dependency order (parents first) for restore. */
export const RESTORE_ORDER = [
  "Project",
  "Statement",
  "SortSession",
  "SortGroup",
  "SortGroupItem",
  "AnalysisRun",
  "AnalysisRunDimension",
  "AnalysisPackage",
  "AnalysisPackageJob",
  "AnalysisInterpretation",
  "AnalysisClusterLabel",
  "AnalysisExecutionLock",
];

export function sha256Buffer(buf: Uint8Array | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function sha256File(file: string): string {
  return sha256Buffer(fs.readFileSync(file));
}

/** Same algorithm as scripts/backup/auto-backup.mjs `contentFingerprint` (kept identical on purpose). */
export function contentFingerprint(db: DatabaseSync): { fingerprint: string; counts: Record<string, number>; perTable: Record<string, string> } {
  const h = crypto.createHash("sha256");
  const counts: Record<string, number> = {};
  const perTable: Record<string, string> = {};
  for (const t of userTables(db)) {
    const rows = readTable(db, t).map((r) => JSON.stringify(r)).sort();
    counts[t] = rows.length;
    const body = t + "\n" + rows.join("\n") + "\n";
    h.update(body);
    perTable[t] = sha256Buffer(body);
  }
  return { fingerprint: h.digest("hex"), counts, perTable };
}

export function walkFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...walkFiles(p, base));
    else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out;
}

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    }
  }
  return out;
}

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Refuses to overwrite: backups are write-once. */
export function writeNew(file: string, data: string | Uint8Array) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, data, { flag: "wx" });
}
