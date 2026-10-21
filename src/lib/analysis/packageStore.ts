import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * Package bytes live next to the SQLite file (on the same persistent volume in production) in
 * `<db dir>/analysis-packages/`. Files are written once under a content-addressed name (`<sha256>.zip`) via
 * temp-file + rename, so a half-written file can never be served, and are re-hashed on every read.
 */
export function packageStorageDir(): string {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("file:")) throw new Error("PACKAGE_STORE_UNAVAILABLE: DATABASE_URL is not a file: URL");
  const rest = url.slice("file:".length).split("?")[0];
  const dbPath = path.isAbsolute(rest) ? rest : path.resolve(process.cwd(), "prisma", rest);
  return path.join(path.dirname(dbPath), "analysis-packages");
}

export const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export function writePackageFile(bytes: Uint8Array): { storedFile: string; sha256: string } {
  const dir = packageStorageDir();
  fs.mkdirSync(dir, { recursive: true });
  const sha256 = sha256Hex(bytes);
  const storedFile = `${sha256}.zip`;
  const target = path.join(dir, storedFile);
  if (!fs.existsSync(target)) {
    const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(tmp, bytes, { flag: "wx" });
    fs.renameSync(tmp, target);
    try {
      fs.chmodSync(target, 0o444); // write-once: discourages in-place edits (backups may hard-link this inode)
    } catch {
      /* best effort */
    }
  }
  return { storedFile, sha256 };
}

export type PackageFileState = "OK" | "MISSING" | "SIZE_MISMATCH";

/** Cheap state of a registered package's file (existence + recorded size; no hashing) for status screens. The full SHA-256 is checked on every download. */
export function packageFileState(storedFile: string, byteSize: number): PackageFileState {
  if (!/^[0-9a-f]{64}\.zip$/.test(storedFile)) return "MISSING";
  try {
    const st = fs.statSync(path.join(packageStorageDir(), storedFile));
    return st.size === byteSize ? "OK" : "SIZE_MISMATCH";
  } catch {
    return "MISSING";
  }
}

export function readPackageFile(storedFile: string, expectedSha256: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}\.zip$/.test(storedFile)) return null;
  const p = path.join(packageStorageDir(), storedFile);
  if (!fs.existsSync(p)) return null;
  const bytes = new Uint8Array(fs.readFileSync(p));
  return sha256Hex(bytes) === expectedSha256 ? bytes : null;
}

/** Best-effort removal once no database row references the file any more. */
export function removePackageFileIfUnreferenced(storedFile: string, stillReferenced: boolean) {
  if (stillReferenced || !/^[0-9a-f]{64}\.zip$/.test(storedFile)) return;
  try {
    fs.unlinkSync(path.join(packageStorageDir(), storedFile));
  } catch {
    /* already gone */
  }
}
