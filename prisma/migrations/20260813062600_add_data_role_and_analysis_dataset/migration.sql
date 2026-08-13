-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AnalysisRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "executionStatus" TEXT NOT NULL,
    "errorCode" TEXT,
    "errorMessageSafe" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "numericDataHash" TEXT NOT NULL,
    "statementStructureHash" TEXT NOT NULL,
    "statementContentHashKo" TEXT NOT NULL,
    "statementContentHashJa" TEXT NOT NULL,
    "parameterHash" TEXT NOT NULL,
    "sourceSnapshotAt" DATETIME NOT NULL,
    "inputSnapshot" TEXT NOT NULL,
    "parametersSnapshot" TEXT NOT NULL,
    "algorithmVersion" TEXT NOT NULL,
    "engineSourceCommitSha" TEXT NOT NULL,
    "primaryMapDimension" INTEGER NOT NULL,
    "wardSourceDimension" INTEGER NOT NULL,
    "linkageMethod" TEXT NOT NULL,
    "dimensionsEvaluated" TEXT NOT NULL,
    "include3dSupplement" BOOLEAN NOT NULL,
    "statementCount" INTEGER NOT NULL,
    "nKr" INTEGER NOT NULL,
    "nJp" INTEGER NOT NULL,
    "nTotal" INTEGER NOT NULL,
    "includedParticipantCount" INTEGER NOT NULL,
    "excludedNullCountry" INTEGER NOT NULL,
    "excludedIncomplete" INTEGER NOT NULL,
    "excludedInvalid" INTEGER NOT NULL,
    "dataset" TEXT NOT NULL DEFAULT 'LEGACY_PRE_SEGREGATION',
    "pilotCount" INTEGER NOT NULL DEFAULT 0,
    "mainCount" INTEGER NOT NULL DEFAULT 0,
    "wardStatus" TEXT NOT NULL,
    "wardLinkageSnapshot" TEXT,
    "wardErrorCode" TEXT,
    "wardErrorMessageSafe" TEXT,
    CONSTRAINT "AnalysisRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AnalysisRun" ("algorithmVersion", "dimensionsEvaluated", "engineSourceCommitSha", "errorCode", "errorMessageSafe", "excludedIncomplete", "excludedInvalid", "excludedNullCountry", "executionStatus", "finishedAt", "id", "include3dSupplement", "includedParticipantCount", "inputSnapshot", "linkageMethod", "nJp", "nKr", "nTotal", "numericDataHash", "parameterHash", "parametersSnapshot", "primaryMapDimension", "projectId", "scope", "sourceSnapshotAt", "startedAt", "statementContentHashJa", "statementContentHashKo", "statementCount", "statementStructureHash", "wardErrorCode", "wardErrorMessageSafe", "wardLinkageSnapshot", "wardSourceDimension", "wardStatus") SELECT "algorithmVersion", "dimensionsEvaluated", "engineSourceCommitSha", "errorCode", "errorMessageSafe", "excludedIncomplete", "excludedInvalid", "excludedNullCountry", "executionStatus", "finishedAt", "id", "include3dSupplement", "includedParticipantCount", "inputSnapshot", "linkageMethod", "nJp", "nKr", "nTotal", "numericDataHash", "parameterHash", "parametersSnapshot", "primaryMapDimension", "projectId", "scope", "sourceSnapshotAt", "startedAt", "statementContentHashJa", "statementContentHashKo", "statementCount", "statementStructureHash", "wardErrorCode", "wardErrorMessageSafe", "wardLinkageSnapshot", "wardSourceDimension", "wardStatus" FROM "AnalysisRun";
DROP TABLE "AnalysisRun";
ALTER TABLE "new_AnalysisRun" RENAME TO "AnalysisRun";
CREATE INDEX "AnalysisRun_projectId_scope_startedAt_idx" ON "AnalysisRun"("projectId", "scope", "startedAt");
CREATE INDEX "AnalysisRun_projectId_executionStatus_idx" ON "AnalysisRun"("projectId", "executionStatus");

-- One-time, provable (not guessed) backfill: every AnalysisRun row that
-- already exists at the moment this migration applies was necessarily
-- computed before the dataRole concept existed, so 100% of its
-- includedParticipantCount came from what this same migration's SortSession
-- default (and the application's subsequent one-time exact-ID backfill)
-- classifies as PILOT. This UPDATE only ever touches rows present at
-- migration-apply time — every AnalysisRun created afterward is inserted by
-- the new application code with its own explicit dataset/pilotCount/
-- mainCount values, never by this statement.
UPDATE "AnalysisRun" SET "pilotCount" = "includedParticipantCount", "mainCount" = 0;
CREATE TABLE "new_SortSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "participantName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consentAgreed" BOOLEAN NOT NULL DEFAULT true,
    "gender" TEXT NOT NULL,
    "age" INTEGER NOT NULL,
    "schoolLevel" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "countryCode" TEXT,
    "dataRole" TEXT NOT NULL DEFAULT 'MAIN',
    CONSTRAINT "SortSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SortSession" ("age", "consentAgreed", "countryCode", "createdAt", "gender", "grade", "id", "participantName", "phoneNumber", "projectId", "schoolLevel") SELECT "age", "consentAgreed", "countryCode", "createdAt", "gender", "grade", "id", "participantName", "phoneNumber", "projectId", "schoolLevel" FROM "SortSession";
DROP TABLE "SortSession";
ALTER TABLE "new_SortSession" RENAME TO "SortSession";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
