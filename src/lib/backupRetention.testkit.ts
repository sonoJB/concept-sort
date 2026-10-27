// Test helpers: call the retention code the way production does — the verification record is read from status.json (mandatory input) and
// applyRetention gets a `replan` that rebuilds the plan from the same inputs. Tests that need a different record write status.json instead.
import fs from "node:fs";
import path from "node:path";
import * as retention from "../../scripts/backup/retention.mjs";

/* eslint-disable @typescript-eslint/no-explicit-any */
const rawPlan = retention.planRetention as unknown as (a: Record<string, unknown>) => any;
const rawApply = retention.applyRetention as unknown as (a: Record<string, unknown>) => any;

type PlanArgs = { root: string; latestDir?: string; liveDbPath?: string; verify: (d: string) => unknown; latestRecord?: unknown; candidateFilter?: (n: string) => boolean };
const lastArgs = new Map<string, PlanArgs>();

/** What the daemon passes: the server's own record of its latest backup (status.json). */
function recordFromStatus(root: string) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(root, "status.json"), "utf8"));
    return { dir: st.lastBackupDir, sha256: st.lastBackupSha256, fingerprint: st.lastBackupFingerprint };
  } catch {
    return null;
  }
}

export function planRetention(args: PlanArgs) {
  lastArgs.set(args.root, args);
  return rawPlan({ ...args, latestRecord: "latestRecord" in args ? args.latestRecord : recordFromStatus(args.root) });
}

export function applyRetention(o: { root: string; plan: any; dryRun?: boolean; onDelete?: (c: unknown) => void; replan?: () => unknown }) {
  const args = lastArgs.get(o.root);
  const replan = "replan" in o ? o.replan : args ? () => planRetention(args) : undefined;
  return rawApply({ ...o, replan });
}
