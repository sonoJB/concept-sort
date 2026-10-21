import fs from "node:fs";
import path from "node:path";

/**
 * Read-only view of the automatic backups written by scripts/backup/*.mjs.
 * Lists metadata only (names, sizes, checksums, row counts) — never the backup
 * files themselves — and never writes, moves or deletes anything.
 *
 * `health` separates the situations an operator must tell apart:
 *   - a recent backup was created / data simply did not change since (OK)
 *   - the periodic check itself stopped running (CHECKS_STOPPED)
 *   - backups are failing (FAILING)
 *   - there is no backup that was re-verified as intact (NO_VERIFIED_COPY)
 *   - disk space is running low (LOW_DISK)
 */

/** The watcher checks every 6 h; more than 13 h without any check means it has stopped. */
export const CHECK_STALE_AFTER_MS = 13 * 60 * 60 * 1000;

export type BackupEntry = {
  dir: string;
  createdAtUtc: string | null;
  reason: string | null;
  bytes: number | null;
  sha256: string | null;
  integrityCheck: string | null;
  tableCounts: Record<string, number> | null;
  /** ZIP files this backup holds (manifest) and files the backup could not capture. */
  packages: number | null;
  packageProblems: number | null;
  source: "automatic" | "manual-folder";
};

export type HealthIssue = "FAILING" | "CHECKS_STOPPED" | "NO_VERIFIED_COPY" | "LOW_DISK" | "PACKAGE_FILES";

export type PackageFileProblem = { scope?: string | null; version?: number | null; runId?: string | null; filename: string | null; problem: string };

export type BackupStatus = {
  enabled: boolean;
  maintenanceMode: boolean;
  lastCheckAt: string | null;
  lastCheckResult: string | null;
  lastBackupAt: string | null;
  lastVerifiedAt: string | null;
  lastVerifiedBackup: string | null;
  lastVerifiedOk: boolean | null;
  lastVerifiedProblems: string[];
  lastError: string | null;
  consecutiveFailures: number;
  freeBytes: number | null;
  lowDisk: boolean;
  /** AnalysisPackage rows at the last scheduled check, and the rows whose ZIP file is missing / damaged on the live volume. */
  packageRows: number | null;
  packageFileProblems: PackageFileProblem[];
  daemonStartedAt: string | null;
  lastDaemonTickAt: string | null;
  /** Hours since the most recent check/tick, or null if never. */
  checkAgeHours: number | null;
  health: { level: "ok" | "warn" | "error" | "disabled"; issues: HealthIssue[]; unchangedSinceLastBackup: boolean };
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

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

export function readBackupStatus(root: string | null, now: Date = new Date(), maintenanceMode = false): BackupStatus {
  const base: BackupStatus = {
    enabled: false,
    maintenanceMode,
    lastCheckAt: null,
    lastCheckResult: null,
    lastBackupAt: null,
    lastVerifiedAt: null,
    lastVerifiedBackup: null,
    lastVerifiedOk: null,
    lastVerifiedProblems: [],
    lastError: null,
    consecutiveFailures: 0,
    freeBytes: null,
    lowDisk: false,
    packageRows: null,
    packageFileProblems: [],
    daemonStartedAt: null,
    lastDaemonTickAt: null,
    checkAgeHours: null,
    health: { level: "disabled", issues: [], unchangedSinceLastBackup: false },
    backups: [],
  };
  if (!root || !fs.existsSync(root)) return base;

  const status = readJson(path.join(root, "status.json")) ?? {};
  const backups: BackupEntry[] = [];
  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name);
    if (name.startsWith(".") || !fs.statSync(dir).isDirectory() || name === "changelog") continue;
    const manifest = readJson(path.join(dir, "manifest.json"));
    const dbFile = fs.readdirSync(dir).find((f) => f.endsWith(".db"));
    backups.push({
      dir: name,
      createdAtUtc: str(manifest?.createdAtUtc),
      reason: str(manifest?.reason),
      bytes: num(manifest?.bytes) ?? (dbFile ? fs.statSync(path.join(dir, dbFile)).size : null),
      sha256: str(manifest?.sha256),
      integrityCheck: str(manifest?.integrityCheck),
      tableCounts: (manifest?.tableCounts as Record<string, number>) ?? null,
      packages: Array.isArray(manifest?.analysisPackages) ? (manifest.analysisPackages as unknown[]).length : null,
      packageProblems: Array.isArray(manifest?.analysisPackageProblems) ? (manifest.analysisPackageProblems as unknown[]).length : null,
      source: manifest ? "automatic" : "manual-folder",
    });
  }

  const lastCheckAt = str(status.lastCheckAt) ?? str(status.lastAttemptAt);
  const lastDaemonTickAt = str(status.lastDaemonTickAt);
  const newest = [lastCheckAt, lastDaemonTickAt].filter((x): x is string => !!x).sort().at(-1) ?? null;
  const checkAgeMs = newest ? now.getTime() - new Date(newest).getTime() : null;
  const consecutiveFailures = num(status.consecutiveFailures) ?? 0;
  const lastVerifiedOk = typeof status.lastVerifiedOk === "boolean" ? status.lastVerifiedOk : null;
  const lowDisk = status.lowDisk === true;
  const lastCheckResult = str(status.lastCheckResult) ?? str(status.lastResult);

  const issues: HealthIssue[] = [];
  if (consecutiveFailures > 0 || status.lastResult === "FAILED") issues.push("FAILING");
  if (checkAgeMs === null || checkAgeMs > CHECK_STALE_AFTER_MS) issues.push("CHECKS_STOPPED");
  if (lastVerifiedOk !== true) issues.push("NO_VERIFIED_COPY");
  const packageFileProblems = Array.isArray(status.packageFileProblems) ? (status.packageFileProblems as PackageFileProblem[]) : [];
  if (packageFileProblems.length > 0) issues.push("PACKAGE_FILES");
  if (lowDisk) issues.push("LOW_DISK");

  return {
    enabled: true,
    maintenanceMode,
    lastCheckAt,
    lastCheckResult,
    lastBackupAt: str(status.lastBackupAt) ?? str(status.lastSuccessAt),
    lastVerifiedAt: str(status.lastVerifiedAt),
    lastVerifiedBackup: str(status.lastVerifiedBackup) ?? str(status.lastBackupDir),
    lastVerifiedOk,
    lastVerifiedProblems: Array.isArray(status.lastVerifiedProblems) ? (status.lastVerifiedProblems as string[]) : [],
    lastError: str(status.lastError),
    consecutiveFailures,
    freeBytes: num(status.freeBytes),
    lowDisk,
    packageRows: num(status.packageRows),
    packageFileProblems,
    daemonStartedAt: str(status.daemonStartedAt),
    lastDaemonTickAt,
    checkAgeHours: checkAgeMs === null ? null : Math.round((checkAgeMs / 3600000) * 10) / 10,
    health: {
      level: issues.includes("FAILING") || issues.includes("CHECKS_STOPPED") || issues.includes("NO_VERIFIED_COPY") || issues.includes("PACKAGE_FILES") ? "error" : issues.length ? "warn" : "ok",
      issues,
      unchangedSinceLastBackup: (lastCheckResult ?? "").startsWith("UNCHANGED") || lastCheckResult === "SKIPPED_UNCHANGED",
    },
    backups,
  };
}
