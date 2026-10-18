/**
 * Runs the SERVER's package verification (manifest + response-table comparison + personal-data scan) on built ZIP files,
 * against a database copy, without starting the application.
 *   DATABASE_URL=file:<db copy> npx tsx scripts/package/check_zip_with_server_guard.ts <zip> [<zip> ...]
 */
import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { PrismaClient } from "../../src/generated/prisma/client";
import { scanPackageForPersonalData, verifyPackageBytes } from "../../src/lib/analysis/packageVerify";

const prisma = new PrismaClient();
async function main() {
let failed = false;
for (const file of process.argv.slice(2)) {
  const bytes = new Uint8Array(readFileSync(file));
  const entries = unzipSync(bytes, { filter: (f) => f.name.endsWith("manifest.json") });
  const manifest = JSON.parse(new TextDecoder().decode(Object.values(entries)[0]));
  const run = await prisma.analysisRun.findUnique({ where: { id: manifest.runId } });
  if (!run || !run.resultBundle) {
    console.log(manifest.scope, "run not found in this database");
    failed = true;
    continue;
  }
  const fp = JSON.parse(run.resultBundle).meta.fingerprints;
  const check = verifyPackageBytes(bytes, { id: run.id, scope: run.scope }, fp, JSON.parse(run.inputSnapshot));
  const pii = await scanPackageForPersonalData(prisma, run.projectId, bytes);
  console.log(manifest.scope, { manifestAndResponses: check.ok ? "OK" : check, personalDataScanClean: pii.clean, findings: pii.findings });
  if (!check.ok || !pii.clean) failed = true;
}
await prisma.$disconnect();
return failed;
}
main().then((f) => process.exit(f ? 1 : 0));
