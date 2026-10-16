import fs from "node:fs";
import path from "node:path";

/**
 * Read-only view of the automatic backups written by
 * scripts/backup/auto-backup.mjs. Lists metadata only (names, sizes,
 * checksums, row counts) — it never exposes the backup files themselves, and
 * it never writes, moves or deletes anything.
 */

export type BackupEntry = {
  dir: string;
  createdAtUtc: string | null;
  reason: string | null;
  bytes: number | null;
  sha256: string | null;
  integrityCheck: string | null;
  tableCounts: Record<string, number> | null;
  source: "automatic" | "manual-folder";
};

export type BackupStatus = {
  enabled: boolean;
  lastAttemptAt: string | null;
  lastResult: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  backups: BackupEntry[];
};

export function backupRootFromDatabaseUrl(databaseUrl: string | undefined): string | null {
  if (!databaseUrl || !databaseUrl.startsWith("file:")) return null;
  let p = databaseUrl.slice("file:".length).split("?")[0];
  if (p.startsWith("//")) p = p.slice(2);
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), "prisma", p);
  return path.join(path.dirname(abs), "backups");
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function readBackupStatus(root: string | null): BackupStatus {
  const empty: BackupStatus = {
    enabled: false,
    lastAttemptAt: null,
    lastResult: null,
    lastError: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    backups: [],
  };
  if (!root || !fs.existsSync(root)) return empty;

  const status = readJson(path.join(root, "status.json")) ?? {};
  const backups: BackupEntry[] = [];
  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name);
    if (name.startsWith(".") || !fs.statSync(dir).isDirectory()) continue;
    const manifest = readJson(path.join(dir, "manifest.json"));
    const dbFile = fs.readdirSync(dir).find((f) => f.endsWith(".db"));
    backups.push({
      dir: name,
      createdAtUtc: (manifest?.createdAtUtc as string) ?? null,
      reason: (manifest?.reason as string) ?? null,
      bytes: (manifest?.bytes as number) ?? (dbFile ? fs.statSync(path.join(dir, dbFile)).size : null),
      sha256: (manifest?.sha256 as string) ?? null,
      integrityCheck: (manifest?.integrityCheck as string) ?? null,
      tableCounts: (manifest?.tableCounts as Record<string, number>) ?? null,
      source: manifest ? "automatic" : "manual-folder",
    });
  }

  return {
    enabled: true,
    lastAttemptAt: (status.lastAttemptAt as string) ?? null,
    lastResult: (status.lastResult as string) ?? null,
    lastError: (status.lastError as string) ?? null,
    lastSuccessAt: (status.lastSuccessAt as string) ?? null,
    consecutiveFailures: (status.consecutiveFailures as number) ?? 0,
    backups,
  };
}
