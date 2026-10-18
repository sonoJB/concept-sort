-- AlterTable
ALTER TABLE "AnalysisRun" ADD COLUMN "resultBundle" TEXT;

-- CreateTable
CREATE TABLE "AnalysisPackage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "manifest" TEXT NOT NULL,
    "storedFile" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnalysisPackage_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisPackage_analysisRunId_key" ON "AnalysisPackage"("analysisRunId");

-- CreateIndex
CREATE INDEX "AnalysisPackage_projectId_scope_idx" ON "AnalysisPackage"("projectId", "scope");
