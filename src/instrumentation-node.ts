import { spawn } from "node:child_process";
import path from "node:path";
import { startPackageWorker } from "@/lib/analysis/packageWorker";

/**
 * Starts the scheduled database-backup watcher (scripts/backup/auto-backup.mjs)
 * as a child process when the production Node server boots.
 *
 * It is a separate plain-Node process on purpose: the backup code uses
 * `node:sqlite` and must not be pulled into the Next.js bundle, and a failure
 * in it can never affect request handling. Nothing here ever throws into the
 * server start-up path.
 */
function startBackupScheduler() {
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.DISABLE_AUTO_BACKUP === "1") return;

  try {
    const script = path.join(process.cwd(), "scripts", "backup", "auto-backup.mjs");
    const child = spawn(process.execPath, ["--no-warnings", script, "--daemon"], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", (err) => console.error("[backup] could not start scheduler:", err));
    child.on("exit", (code) => {
      if (code !== 0) console.error(`[backup] scheduler process exited with code ${code}`);
    });
  } catch (err) {
    console.error("[backup] scheduler start-up failed (the app continues without it):", err);
  }
}

startBackupScheduler();

/** Package pipeline worker (see lib/analysis/packageWorker.ts). Disabled with DISABLE_PACKAGE_WORKER=1. */
function startPackagePipeline() {
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.DISABLE_PACKAGE_WORKER === "1") return;
  try {
    startPackageWorker();
  } catch (err) {
    console.error("[package-worker] start-up failed (the app continues without it):", err);
  }
}

startPackagePipeline();
