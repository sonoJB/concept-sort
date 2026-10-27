#!/usr/bin/env node
/**
 * PC side of the "latest set" policy: copies the server's newest VERIFIED backup set (database + manifest.json + analysis-packages/) to a
 * folder on this PC and marks it as the PC's latest copy ONLY after every file has been verified here.
 *
 *   node scripts/backup/pull-latest-to-pc.mjs --dest <folder> [--service <railway service id>] [--prune]
 *   node scripts/backup/pull-latest-to-pc.mjs --dest <folder> --status        (offline: shows what the PC records say, no server access)
 *
 * Transport: `railway ssh -- base64 <file>` (read-only on the server; binary-safe because the text is decoded locally).
 *
 * Rules (all enforced below and tested):
 *   - the server's own status.json must say its latest backup is verified (lastVerifiedOk) AND its recorded SHA-256 must equal the
 *     manifest's — a disagreeing verification record means nothing is pulled
 *   - the set is assembled in `<dest>/.pull-*`; every file is checked against the SIZE and SHA-256 in the server's manifest, the copy is
 *     verified again locally (SQLite integrity_check, package hashes), and only then it is renamed to `<dest>/<backup name>`
 *   - `<dest>/PC_LATEST.json` is the LAST-SUCCESS record. It is rewritten ONLY after that rename and names the exact backup ID, the SHA-256 of
 *     manifest.json and the SHA-256 of every file. A failed, partial or unverified transfer never changes it.
 *   - `<dest>/PC_SYNC.json` is the CURRENT-STATE record, rewritten on every run (also when the server cannot be reached):
 *       동기화됨      the server's latest backup (same ID + same manifest hash) is on this PC, as of `checkedAt`
 *       동기화 대기   the server's latest backup is NOT (yet) on this PC — pulled failed or refused; the PC copy is an OLDER backup
 *       확인 불가     the server could not be asked, so whether the newest backup is on this PC is unknown
 *     A past success is never read as "the newest backup is on the PC": only `동기화됨` says that, and only for the time it was checked.
 *   - an existing PC copy counts as up to date only if its recorded manifest hash equals the server's current manifest hash and it re-verifies
 *   - `--prune` applies the SAME retention rules as the server (retention.mjs planRetention/applyRetention), never just "name + marker":
 *       an older PC copy is removed only if it is a copy this script created (PC_VERIFIED.json), AND every row of every comparable table is held,
 *       value for value, by the newest verified copy or by the RAW baseline (pulled from the server and verified here), AND it is not protected by the
 *       server policy. The server policy (`retention-policy.json`) is fetched with the pull; without it, or with any doubt, every copy is kept.
 *       Baseline, protected copies, unmarked folders and sole copies of anything are never removed. The plan is rebuilt right before the removal.
 *   - one pull at a time per destination folder (shared lock with ownership token)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyBackupDir } from "./auto-backup.mjs";
import { acquireLock, applyRetention, planRetention, POLICY_FILE, readPolicy, removeStaleTemp } from "./retention.mjs";

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const MARK = "PC_VERIFIED.json";
const LATEST = "PC_LATEST.json";
const SYNC = "PC_SYNC.json";
const NAME = /^\d{8}T\d{6}Z_[a-z0-9-]+$/;
const SET_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/; // an automatic backup name or the policy's RAW baseline name

export const STATE_SYNCED = "동기화됨";
export const STATE_WAITING = "동기화 대기";
export const STATE_UNKNOWN = "확인 불가";

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readMark(dir) {
  return readJson(path.join(dir, MARK));
}

function recordSync(dest, now, state, extra) {
  const lastSuccess = readJson(path.join(dest, LATEST));
  try {
    writeJsonAtomic(path.join(dest, SYNC), {
      state,
      checkedAt: now.toISOString(),
      ...extra,
      // copied for convenience only; the authoritative last-success record is PC_LATEST.json and it is never touched here
      lastSuccessRecord: lastSuccess ? { backupId: lastSuccess.backupId ?? lastSuccess.dir, verifiedAt: lastSuccess.verifiedAt } : null,
      note: "PC_LATEST.json is the last-success record only. Only state=동기화됨 means the server's newest backup is on this PC (as of checkedAt).",
    });
  } catch {
    // the sync record is informational; a failure to write it must not hide the result
  }
}

/**
 * Copies one backup set (`dir`) from the server into `<dest>/<dir>`: every file is checked against the SIZE and SHA-256 in the server's manifest,
 * the assembled copy is verified again locally and only then renamed into place and marked. Throws on any problem (nothing is published then).
 * Returns the record that was written to PC_VERIFIED.json.
 */
function fetchSet({ transport, dest, dir, now, manifestBytes }) {
  const bytes = manifestBytes ?? transport.readBytes(`${dir}/manifest.json`);
  const manifest = JSON.parse(bytes.toString("utf8"));
  const plain = (n) => typeof n === "string" && n !== "" && n !== "." && n !== ".." && n === path.basename(n) && !/[\\/]/.test(n);
  if (!plain(manifest.file) || (manifest.analysisPackages ?? []).some((p) => !plain(p.file))) throw new Error("the manifest names a file outside the backup folder");
  const tmp = path.join(dest, `.pull-${now.toISOString().replace(/[-:.]/g, "")}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`);
  fs.mkdirSync(tmp);
  try {
    const files = [];
    const take = (rel, expectSha, expectBytes, localRel) => {
      const buf = transport.readBytes(`${dir}/${rel}`);
      if (buf.length !== expectBytes) throw new Error(`size mismatch for ${rel}`);
      if (sha256(buf) !== expectSha) throw new Error(`SHA-256 mismatch for ${rel}`);
      const out = path.join(tmp, localRel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, buf);
      files.push({ file: localRel.replace(/\\/g, "/"), bytes: buf.length, sha256: expectSha });
    };
    take(manifest.file, manifest.sha256, manifest.bytes, manifest.file);
    for (const p of manifest.analysisPackages ?? []) take(`analysis-packages/${p.file}`, p.sha256, p.bytes, path.join("analysis-packages", p.file));
    fs.writeFileSync(path.join(tmp, "manifest.json"), bytes);
    const check = verifyBackupDir(tmp); // SHA-256 again, SQLite integrity_check, every package file
    if (!check.ok) throw new Error("local verification failed: " + check.problems.join("; "));
    const record = { backupId: dir, dir, dbSha256: manifest.sha256, manifestSha256: sha256(bytes), files, verifiedAt: now.toISOString() };
    writeJsonAtomic(path.join(tmp, MARK), { ...record, source: "server backups folder (read-only copy)" });
    fs.renameSync(tmp, path.join(dest, dir));
    return record;
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

const isOurs = (dest, name) => {
  try {
    const p = path.join(dest, name);
    return !fs.lstatSync(p).isSymbolicLink() && fs.lstatSync(p).isDirectory() && !!readMark(p);
  } catch {
    return false;
  }
};

/**
 * Removes older PC copies under the SAME rules as the server (see retention.mjs): the server's policy file is fetched, the RAW baseline it names is
 * pulled and verified here, and a copy is removed only if every row of every comparable table is held by the newest verified copy or the baseline.
 * Never throws; anything unclear keeps every copy.
 */
function prunePc({ transport, dest, latestDir, record, now, owns }) {
  const out = { removed: [], notApplied: null, errors: [] };
  try {
    removeStaleTemp(dest, now); // finishes an interrupted earlier removal (.deleting-*), never touches anything else
    const policyBytes = transport.readBytes(POLICY_FILE);
    const tmpPolicy = path.join(dest, `${POLICY_FILE}.tmp-${process.pid}`);
    fs.writeFileSync(tmpPolicy, policyBytes);
    fs.renameSync(tmpPolicy, path.join(dest, POLICY_FILE));
    const pol = readPolicy(dest);
    if (!pol.ok) {
      out.notApplied = pol.reason;
      return out;
    }
    const baseName = pol.policy.rawBaseline;
    if (!SET_NAME.test(baseName)) {
      out.notApplied = "POLICY_INVALID";
      return out;
    }
    if (fs.existsSync(path.join(dest, baseName))) {
      // an existing folder is usable as the baseline only if this script made it and it still verifies
      if (!isOurs(dest, baseName) || !verifyBackupDir(path.join(dest, baseName)).ok) {
        out.notApplied = "BASELINE_UNAVAILABLE";
        return out;
      }
    } else {
      fetchSet({ transport, dest, dir: baseName, now });
    }
    const makePlan = () => planRetention({ root: dest, latestDir, verify: (d) => verifyBackupDir(d), latestRecord: record, candidateFilter: (n) => isOurs(dest, n) });
    const plan = makePlan();
    if (!plan.enabled) {
      out.notApplied = plan.reason;
      return out;
    }
    const res = applyRetention({ root: dest, plan, dryRun: false, replan: makePlan, ownsLock: owns });
    out.removed = res.deleted.map((d) => d.dir);
    out.errors = res.errors;
    out.kept = res.kept;
  } catch (e) {
    out.notApplied = "PRUNE_FAILED: " + (e instanceof Error ? e.message : String(e));
  }
  return out;
}

/**
 * @param {{ transport: { readBytes(rel: string): Buffer }, dest: string, now?: Date, prune?: boolean }} o
 *   transport paths are relative to the server's backups folder ("status.json", "retention-policy.json", "<dir>/manifest.json", "<dir>/<file>", "<dir>/analysis-packages/<zip>")
 */
export function pullLatest({ transport, dest, now = new Date(), prune = false }) {
  fs.mkdirSync(dest, { recursive: true });
  const release = acquireLock(dest, now);
  if (!release) return { result: "NOT_PULLED", reason: "another pull is running for this folder", state: pcStatus({ dest }).state };
  try {
    return pullLocked({ transport, dest, now, prune, owns: release.owns });
  } finally {
    release();
  }
}

function pullLocked({ transport, dest, now, prune, owns }) {
  let serverLatest = null;
  const finish = (res, state, extra = {}) => {
    recordSync(dest, now, state, { serverLatest, result: res.result, reason: res.reason ?? res.error ?? null, ...extra });
    return { ...res, state };
  };
  try {
    let status;
    try {
      status = JSON.parse(transport.readBytes("status.json").toString("utf8"));
    } catch (e) {
      // the server could not be asked: we do NOT know whether the newest backup is on this PC
      return finish({ result: "FAILED", error: e instanceof Error ? e.message : String(e) }, STATE_UNKNOWN);
    }
    const dir = status.lastBackupDir;
    if (!dir || status.lastVerifiedOk !== true || status.lastVerifiedBackup !== dir) {
      return finish({ result: "NOT_PULLED", reason: "the server's latest backup is not recorded as verified" }, STATE_WAITING, { serverLatest: dir ? { backupId: dir } : null });
    }
    if (!NAME.test(dir)) return finish({ result: "NOT_PULLED", reason: "unexpected backup name" }, STATE_WAITING);

    const manifestBytes = transport.readBytes(`${dir}/manifest.json`);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const manifestSha256 = sha256(manifestBytes);
    serverLatest = { backupId: dir, dbSha256: manifest.sha256, manifestSha256 };
    // the server's verification record must exist and describe exactly this manifest (it is also the record the prune plan is checked against)
    if (!status.lastBackupSha256 || !status.lastBackupFingerprint || status.lastBackupSha256 !== manifest.sha256 || status.lastBackupFingerprint !== manifest.contentFingerprint) {
      return finish({ result: "NOT_PULLED", reason: "the server's verification record is missing or does not match the backup's manifest (SHA-256 / fingerprint)" }, STATE_WAITING);
    }
    const record = { dir, sha256: status.lastBackupSha256, fingerprint: status.lastBackupFingerprint };

    const target = path.join(dest, dir);
    let res;
    if (fs.existsSync(target)) {
      const prevMark = readMark(target);
      if (!prevMark) return finish({ result: "NOT_PULLED", reason: "a folder with that name exists here but was not created by this script" }, STATE_WAITING);
      // same name is not enough: the PC copy must carry the same manifest hash AND still verify
      if (prevMark.manifestSha256 !== manifestSha256 || prevMark.dbSha256 !== manifest.sha256) {
        return finish({ result: "NOT_PULLED", reason: "a PC copy with that name exists but its recorded hashes differ from the server's manifest" }, STATE_WAITING);
      }
      const again = verifyBackupDir(target);
      if (!again.ok) return finish({ result: "NOT_PULLED", reason: "the PC copy no longer verifies: " + again.problems.join("; ") }, STATE_WAITING);
      res = finish({ result: "UP_TO_DATE", dir }, STATE_SYNCED, { pcLatest: { backupId: dir, manifestSha256 } });
    } else {
      const rec = fetchSet({ transport, dest, dir, now, manifestBytes });
      writeJsonAtomic(path.join(dest, LATEST), rec);
      res = finish({ result: "OK", dir, files: rec.files.length }, STATE_SYNCED, { pcLatest: { backupId: dir, manifestSha256 } });
    }
    if (prune) {
      const p = prunePc({ transport, dest, latestDir: dir, record, now, owns });
      res.removed = p.removed;
      if (p.notApplied) res.pruneNotApplied = p.notApplied;
      if (p.errors.length) res.pruneErrors = p.errors;
    }
    return res;
  } catch (e) {
    // the server answered but this transfer did not complete: the newest backup is known NOT to be (fully) on the PC
    return finish({ result: "FAILED", error: e instanceof Error ? e.message : String(e) }, STATE_WAITING);
  }
}

/**
 * What to show for "PC latest" WITHOUT contacting the server. A recorded success is reported only as a last-success record;
 * the current state is whatever the last attempt recorded, and unknown when there is none.
 */
export function pcStatus({ dest }) {
  const sync = readJson(path.join(dest, SYNC));
  const last = readJson(path.join(dest, LATEST));
  return {
    state: sync?.state ?? STATE_UNKNOWN,
    checkedAt: sync?.checkedAt ?? null,
    reason: sync?.reason ?? (sync ? null : "no sync check has been recorded"),
    lastSuccess: last ? { backupId: last.backupId ?? last.dir, manifestSha256: last.manifestSha256 ?? null, verifiedAt: last.verifiedAt } : null,
    meaning:
      "lastSuccess only says which backup was copied and verified in the past. It does not say the server's newest backup is on this PC; only state=동기화됨 does, as of checkedAt.",
  };
}

/** Transport over `railway ssh` (the server path is fixed to the service's backups folder). */
export function railwayTransport({ service, backupsRoot = "/data/backups", exe = process.env.RAILWAY_EXE || "railway" }) {
  return {
    readBytes(rel) {
      if (rel.includes("..") || rel.startsWith("/")) throw new Error("bad path");
      const r = spawnSync(exe, ["ssh", "--service", service, "--", "base64", `${backupsRoot}/${rel}`], { maxBuffer: 1 << 30, env: { ...process.env, MSYS_NO_PATHCONV: "1" }, shell: process.platform === "win32" && exe.toLowerCase().endsWith(".cmd") });
      if (r.status !== 0) throw new Error(`cannot read ${rel} from the server (exit ${r.status})`);
      const text = r.stdout.toString("ascii").replace(/[^A-Za-z0-9+/=]/g, "");
      return Buffer.from(text, "base64");
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const dest = get("--dest");
  const service = get("--service") ?? process.env.RAILWAY_SERVICE_ID;
  if (dest && args.includes("--status")) {
    console.log(JSON.stringify(pcStatus({ dest }), null, 2));
    process.exit(0);
  }
  if (!dest || !service) {
    console.error("usage: pull-latest-to-pc.mjs --dest <folder> --service <railway service id> [--prune]\n       pull-latest-to-pc.mjs --dest <folder> --status");
    process.exit(2);
  }
  const res = pullLatest({ transport: railwayTransport({ service }), dest, prune: args.includes("--prune") });
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.result === "OK" || res.result === "UP_TO_DATE" ? 0 : 1);
}
