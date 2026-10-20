/**
 * Operator / test helper for the package pipeline (the server does the same in its background worker).
 *   DATABASE_URL=file:<db> npx tsx scripts/package/run_package_jobs.ts [--enqueue <runId> [auto|retry|rebuild]] [--max <n>]
 * Queues a job when asked, then processes queued jobs (build -> verify -> register) until none is left. The analysis is
 * never recomputed. Prints job states only.
 */
import { PrismaClient } from "../../src/generated/prisma/client";
import { enqueuePackageJob, processNextPackageJob, serializePackageJob } from "../../src/lib/analysis/packageJobs";

async function main() {
  const prisma = new PrismaClient();
  const args = process.argv.slice(2);
  const e = args.indexOf("--enqueue");
  if (e >= 0) {
    const trig = (args[e + 2] ?? "auto").toUpperCase() as "AUTO" | "RETRY" | "REBUILD";
    const r = await enqueuePackageJob(prisma, args[e + 1], trig);
    console.log("enqueue:", r.ok ? { reason: r.reason, job: serializePackageJob(r.job) } : r);
  }
  const max = Number(args[args.indexOf("--max") + 1]) || 10;
  for (let i = 0; i < max; i++) {
    const t = Date.now();
    const j = await processNextPackageJob(prisma);
    if (!j) break;
    console.log(`job ${j.id} run ${j.analysisRunId} -> ${j.status}${j.errorCode ? " " + j.errorCode : ""} (${((Date.now() - t) / 1000).toFixed(0)}s)`);
  }
  await prisma.$disconnect();
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
