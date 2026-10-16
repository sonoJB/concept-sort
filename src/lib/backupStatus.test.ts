import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readBackupStatus, CHECK_STALE_AFTER_MS } from "./backupStatus";
import { isMaintenanceMode, maintenanceFlagPath } from "./maintenanceMode";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "concept-sort-status-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function volume(name: string, status: Record<string, unknown> | null) {
  const dir = path.join(root, name, "backups");
  fs.mkdirSync(path.join(dir, "20261016T000000Z_x"), { recursive: true });
  fs.writeFileSync(path.join(dir, "20261016T000000Z_x", "manifest.json"), JSON.stringify({ createdAtUtc: "2026-10-16T00:00:00Z", reason: "x", bytes: 5, sha256: "a", integrityCheck: "ok" }));
  fs.writeFileSync(path.join(dir, "20261016T000000Z_x", "b.db"), "12345");
  fs.mkdirSync(path.join(dir, "changelog"), { recursive: true }); // must not be listed as a backup
  if (status) fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status));
  return dir;
}
const NOW = new Date("2026-10-20T12:00:00Z");
const good = {
  lastCheckAt: "2026-10-20T10:00:00Z",
  lastCheckResult: "UNCHANGED_PREVIOUS_BACKUP_VERIFIED",
  lastBackupAt: "2026-10-16T12:00:00Z",
  lastVerifiedOk: true,
  lastVerifiedAt: "2026-10-20T10:00:00Z",
  lastVerifiedBackup: "20261016T000000Z_x",
  consecutiveFailures: 0,
  freeBytes: 4e8,
  lowDisk: false,
};

describe("readBackupStatus health", () => {
  it("old last-backup date with a recent verified check is OK (data simply did not change)", () => {
    const s = readBackupStatus(volume("ok", good), NOW);
    expect(s.health).toEqual({ level: "ok", issues: [], unchangedSinceLastBackup: true });
    expect(s.lastBackupAt).toBe("2026-10-16T12:00:00Z");
    expect(s.checkAgeHours).toBe(2);
    expect(s.backups.map((b) => b.dir)).toEqual(["20261016T000000Z_x"]);
  });

  it("no check for longer than the stale window is reported as CHECKS_STOPPED, distinct from unchanged data", () => {
    const stale = { ...good, lastCheckAt: new Date(NOW.getTime() - CHECK_STALE_AFTER_MS - 60000).toISOString() };
    const s = readBackupStatus(volume("stopped", stale), NOW);
    expect(s.health.issues).toEqual(["CHECKS_STOPPED"]);
    expect(s.health.level).toBe("error");
  });

  it("the scheduler heartbeat counts as a check", () => {
    const s = readBackupStatus(volume("heartbeat", { ...good, lastCheckAt: "2026-10-01T00:00:00Z", lastDaemonTickAt: "2026-10-20T11:00:00Z" }), NOW);
    expect(s.health.issues).not.toContain("CHECKS_STOPPED");
  });

  it("failures, unverified copy and low disk are separate issues", () => {
    const s = readBackupStatus(volume("bad", { ...good, consecutiveFailures: 3, lastResult: "FAILED", lastVerifiedOk: false, lowDisk: true, lastError: "boom" }), NOW);
    expect(s.health.issues.sort()).toEqual(["FAILING", "LOW_DISK", "NO_VERIFIED_COPY"].sort());
    expect(s.consecutiveFailures).toBe(3);
    expect(s.lastError).toBe("boom");
  });

  it("low disk alone is a warning", () => {
    expect(readBackupStatus(volume("lowdisk", { ...good, lowDisk: true }), NOW).health).toMatchObject({ level: "warn", issues: ["LOW_DISK"] });
  });

  it("a legacy status file without verification fields counts as 'no verified copy'", () => {
    const s = readBackupStatus(volume("legacy", { lastAttemptAt: "2026-10-20T10:00:00Z", lastResult: "OK", lastSuccessAt: "2026-10-20T10:00:00Z", lastBackupDir: "20261016T000000Z_x" }), NOW);
    expect(s.health.issues).toContain("NO_VERIFIED_COPY");
  });

  it("missing status file or directory", () => {
    expect(readBackupStatus(volume("nostatus", null), NOW).health.issues).toContain("CHECKS_STOPPED");
    expect(readBackupStatus(path.join(root, "nope"), NOW).enabled).toBe(false);
    expect(readBackupStatus(null, NOW).health.level).toBe("disabled");
  });
});

describe("maintenance flag", () => {
  it("is the file MAINTENANCE next to the database file", () => {
    const dir = path.join(root, "maint");
    fs.mkdirSync(dir, { recursive: true });
    const url = `file:${path.join(dir, "prod.db")}`;
    expect(maintenanceFlagPath(url)).toBe(path.join(dir, "MAINTENANCE"));
    expect(isMaintenanceMode(url)).toBe(false);
    fs.writeFileSync(path.join(dir, "MAINTENANCE"), "");
    expect(isMaintenanceMode(url)).toBe(true);
    expect(readBackupStatus(path.join(dir, "backups"), NOW, isMaintenanceMode(url)).maintenanceMode).toBe(true);
    expect(isMaintenanceMode("postgres://x")).toBe(false);
  });
});
