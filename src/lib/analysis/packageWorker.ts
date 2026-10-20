import { prisma } from "@/lib/db";
import { processNextPackageJob, recoverStaleJobs } from "./packageJobs";

let started = false;

/**
 * Background worker of the package pipeline (analysis finished -> build -> verify -> register -> ready). It runs inside
 * the server process, one job at a time, polling the job table; the heavy work (figures, report) happens in a child
 * process, so the server keeps answering requests. At start every in-flight job of the previous process is put back in the
 * queue (server restart recovery); afterwards jobs that stopped reporting a heartbeat are recovered the same way.
 * Never throws into the server start-up path.
 */
export function startPackageWorker(intervalMs = 10_000) {
  if (started) return;
  started = true;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await recoverStaleJobs(prisma);
      await processNextPackageJob(prisma);
    } catch (e) {
      console.error("[package-worker] tick failed:", e instanceof Error ? e.message : e);
    } finally {
      busy = false;
    }
  };
  void recoverStaleJobs(prisma, { ignoreHeartbeat: true })
    .then((r) => {
      if (r.requeued || r.failed) console.log(`[package-worker] recovered after restart: requeued ${r.requeued}, failed ${r.failed}`);
    })
    .catch((e) => console.error("[package-worker] recovery failed:", e instanceof Error ? e.message : e));
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
}
