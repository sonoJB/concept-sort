-- Several package versions per run; additive columns with defaults (existing packages become version 1).
-- DropIndex
DROP INDEX "AnalysisPackage_analysisRunId_key";

-- AlterTable
ALTER TABLE "AnalysisPackage" ADD COLUMN "packageVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AnalysisPackage" ADD COLUMN "builderVersion" TEXT;
ALTER TABLE "AnalysisPackage" ADD COLUMN "textVersion" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisPackage_analysisRunId_packageVersion_key" ON "AnalysisPackage"("analysisRunId", "packageVersion");

-- CreateTable
CREATE TABLE "AnalysisPackageJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "targetVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'AUTO',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessageSafe" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "heartbeatAt" DATETIME,
    "finishedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisPackageJob_analysisRunId_targetVersion_key" ON "AnalysisPackageJob"("analysisRunId", "targetVersion");

-- CreateIndex
CREATE INDEX "AnalysisPackageJob_projectId_scope_status_idx" ON "AnalysisPackageJob"("projectId", "scope", "status");
