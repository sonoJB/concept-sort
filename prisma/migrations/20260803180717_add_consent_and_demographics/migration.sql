/*
  Warnings:

  - Added the required column `age` to the `SortSession` table without a default value. This is not possible if the table is not empty.
  - Added the required column `gender` to the `SortSession` table without a default value. This is not possible if the table is not empty.
  - Added the required column `grade` to the `SortSession` table without a default value. This is not possible if the table is not empty.
  - Added the required column `phoneNumber` to the `SortSession` table without a default value. This is not possible if the table is not empty.
  - Added the required column `schoolLevel` to the `SortSession` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
    CONSTRAINT "SortSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SortSession" ("createdAt", "id", "participantName", "projectId") SELECT "createdAt", "id", "participantName", "projectId" FROM "SortSession";
DROP TABLE "SortSession";
ALTER TABLE "new_SortSession" RENAME TO "SortSession";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
