-- CreateTable
CREATE TABLE "AnalysisRun" (
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
    "wardStatus" TEXT NOT NULL,
    "wardLinkageSnapshot" TEXT,
    "wardErrorCode" TEXT,
    "wardErrorMessageSafe" TEXT,
    CONSTRAINT "AnalysisRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AnalysisRunDimension" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "analysisRunId" TEXT NOT NULL,
    "dimension" INTEGER NOT NULL,
    "dimensionStatus" TEXT NOT NULL,
    "coordinates" TEXT,
    "rawStress" REAL,
    "commonStressDistance" REAL,
    "commonStressQ" REAL,
    "converged" BOOLEAN,
    "iterations" INTEGER,
    "bestInitIndex" INTEGER,
    "bestSeed" INTEGER,
    "stressHistory" TEXT,
    "normalizationMeta" TEXT,
    "errorCode" TEXT,
    "errorMessageSafe" TEXT,
    CONSTRAINT "AnalysisRunDimension_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AnalysisInterpretation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "analysisRunId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "previousInterpretationId" TEXT,
    "selectedClusterCount" INTEGER NOT NULL,
    "axisLabels" TEXT,
    "quadrantLabels" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizedAt" DATETIME,
    CONSTRAINT "AnalysisInterpretation_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AnalysisInterpretation_previousInterpretationId_fkey" FOREIGN KEY ("previousInterpretationId") REFERENCES "AnalysisInterpretation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AnalysisClusterLabel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "analysisInterpretationId" TEXT NOT NULL,
    "clusterIndex" INTEGER NOT NULL,
    "language" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "memo" TEXT,
    CONSTRAINT "AnalysisClusterLabel_analysisInterpretationId_fkey" FOREIGN KEY ("analysisInterpretationId") REFERENCES "AnalysisInterpretation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AnalysisExecutionLock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "acquiredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnalysisExecutionLock_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AnalysisExecutionLock_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AnalysisRun_projectId_scope_startedAt_idx" ON "AnalysisRun"("projectId", "scope", "startedAt");

-- CreateIndex
CREATE INDEX "AnalysisRun_projectId_executionStatus_idx" ON "AnalysisRun"("projectId", "executionStatus");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisRunDimension_analysisRunId_dimension_key" ON "AnalysisRunDimension"("analysisRunId", "dimension");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisInterpretation_analysisRunId_version_key" ON "AnalysisInterpretation"("analysisRunId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisClusterLabel_analysisInterpretationId_clusterIndex_language_key" ON "AnalysisClusterLabel"("analysisInterpretationId", "clusterIndex", "language");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisExecutionLock_analysisRunId_key" ON "AnalysisExecutionLock"("analysisRunId");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisExecutionLock_projectId_scope_key" ON "AnalysisExecutionLock"("projectId", "scope");
