-- AlterTable
ALTER TABLE "SortSession" ADD COLUMN "countryCode" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "adminToken" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "prompt" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "titleJa" TEXT,
    "promptJa" TEXT,
    "consentKo" TEXT,
    "consentJa" TEXT,
    "koreanEnabled" BOOLEAN NOT NULL DEFAULT false,
    "japaneseEnabled" BOOLEAN NOT NULL DEFAULT false,
    "legacyConsentFallbackEnabled" BOOLEAN NOT NULL DEFAULT false,
    "koPreviewConfirmedAt" DATETIME,
    "jaPreviewConfirmedAt" DATETIME
);
INSERT INTO "new_Project" ("adminToken", "createdAt", "id", "prompt", "slug", "title", "koreanEnabled", "japaneseEnabled", "legacyConsentFallbackEnabled", "koPreviewConfirmedAt") SELECT "adminToken", "createdAt", "id", "prompt", "slug", "title", true, false, true, CURRENT_TIMESTAMP FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");
CREATE UNIQUE INDEX "Project_adminToken_key" ON "Project"("adminToken");
CREATE TABLE "new_Statement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "textJa" TEXT,
    "jaStatus" TEXT NOT NULL DEFAULT 'MISSING',
    CONSTRAINT "Statement_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Statement" ("id", "order", "projectId", "text") SELECT "id", "order", "projectId", "text" FROM "Statement";
DROP TABLE "Statement";
ALTER TABLE "new_Statement" RENAME TO "Statement";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
