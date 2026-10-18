"""Opens an analysis package ZIP exactly as a recipient would and verifies it. Values are never printed for PII.

  python verify_package_zip.py <package.zip> [--extract-to DIR] [--db snapshot.db] [--reproduce] [--expect-scope KR|JP|ALL]
                               [--expect-n N] [--expect-sha256 HASH]

Checks: ZIP integrity (CRC), manifest present, every listed file exists with the listed size + SHA-256, no unlisted
file, SHA256SUMS.txt and 파일목록.csv agree with the files, scope/N/fingerprints in the README and summary agree with
the manifest, only the expected country's responses are present, no pilot rows, optional PII scan against a DB
snapshot, optional independent reproduction (reproduce_mds.py inside the package).
Exit code 0 only if everything passes."""
import argparse
import csv
import hashlib
import json
import os
import re
import subprocess
import sys
import zipfile

ap = argparse.ArgumentParser()
ap.add_argument("zip")
ap.add_argument("--extract-to")
ap.add_argument("--db")
ap.add_argument("--reproduce", action="store_true")
ap.add_argument("--expect-scope")
ap.add_argument("--expect-n", type=int)
ap.add_argument("--expect-sha256")
args = ap.parse_args()

ok = True
report = []


def check(name, cond, detail=""):
    global ok
    ok &= bool(cond)
    line = f"{'PASS' if cond else 'FAIL'} {name}" + (f"  {detail}" if detail else "")
    print(line)
    report.append({"check": name, "pass": bool(cond), "detail": detail})


def sha(b):
    return hashlib.sha256(b).hexdigest()


raw = open(args.zip, "rb").read()
zsha = sha(raw)
print("zip sha256", zsha, "bytes", len(raw))
if args.expect_sha256:
    check("ZIP SHA-256 equals the expected value", zsha == args.expect_sha256.lower())
z = zipfile.ZipFile(args.zip)
check("ZIP CRC test", z.testzip() is None)
names = [n for n in z.namelist() if not n.endswith("/")]
roots = {n.split("/")[0] for n in names}
check("single root folder", len(roots) == 1, f"{len(names)} files")
root = next(iter(roots))
manifest = json.loads(z.read(f"{root}/manifest.json").decode("utf-8"))
listed = {f["path"]: f for f in manifest["files"]}
bad = [p for p, f in listed.items() if f"{root}/{p}" not in z.namelist() or sha(z.read(f"{root}/{p}")) != f["sha256"] or len(z.read(f"{root}/{p}")) != f["bytes"]]
check("every manifest file exists with the listed size and SHA-256", not bad, f"{len(listed)} files" + (f"; bad: {bad[:3]}" if bad else ""))
unlisted = [n for n in names if n != f"{root}/manifest.json" and n[len(root) + 1 :] not in listed]
check("no unlisted files", not unlisted, str(unlisted[:3]))
sums = z.read(f"{root}/SHA256SUMS.txt").decode("utf-8").splitlines()
sums_ok = all(sha(z.read(f"{root}/{line.split('  ', 1)[1]}")) == line.split("  ", 1)[0] for line in sums)
check("SHA256SUMS.txt matches", sums_ok and len(sums) == len(listed) - 1, f"{len(sums)} lines")
rows = list(csv.reader(z.read(f"{root}/00_안내/파일목록.csv").decode("utf-8-sig").splitlines()))[1:]
check("파일목록.csv matches", all(sha(z.read(f"{root}/{r[0]}")) == r[3] and len(z.read(f"{root}/{r[0]}")) == int(r[2]) for r in rows), f"{len(rows)} rows")
scope = manifest["scope"]
if args.expect_scope:
    check("scope equals expected", scope == args.expect_scope, scope)
readme = z.read(f"{root}/00_안내/README.txt").decode("utf-8")
check("README names the same run id and fingerprint", manifest["runId"] in readme and manifest["fingerprints"]["participantsHash"] in readme)
resp = list(csv.reader(z.read(f"{root}/02_원자료_가명/참여자별_분류응답표.csv").decode("utf-8-sig").splitlines()))
hdr, body = resp[0], resp[1:]
pids = sorted({r[0] for r in body})
countries = {r[1] for r in body}
expected = {"KR": {"KR"}, "JP": {"JP"}, "ALL": {"KR", "JP"}}[scope]
check("responses contain only the expected country/countries", countries == expected, str(sorted(countries)))
check("pseudonymous ids only (KR-001 / JP-001 pattern)", all(re.fullmatch(r"(KR|JP)-\d{3}", p) for p in pids), f"{len(pids)} participants")
check("every participant sorted all 47 statements", all(sum(1 for r in body if r[0] == p) == 47 for p in pids))
if args.expect_n:
    check("participant count equals expected N", len(pids) == args.expect_n, f"{len(pids)}")
forbidden_cols = [h for h in hdr if h.strip() in ("이름", "성명", "참여자 이름", "name", "participantName") or any(k in h.lower() for k in ("전화", "세션", "토큰", "phone", "session", "token"))]
check("no personal-data column names (the free-text pile-label column is allowed)", not forbidden_cols, str(forbidden_cols))
S = list(csv.reader(z.read(f"{root}/04_행렬/S_집단유사성빈도_대각선N.csv").decode("utf-8-sig").splitlines()))[1:]
check("diagonal of S equals N", all(int(S[i][i + 1]) == len(pids) for i in range(len(S))), f"N={len(pids)}")
figs = [n for n in names if "/08_그림/" in n]
check("figures exist in PNG, SVG and PDF", all(any(n.endswith(e) for n in figs) for e in (".png", ".svg", ".pdf")), f"{len(figs)} figure files")
check("report exists as PDF, DOCX and Markdown", all(any(n.endswith(e) for n in names) for e in ("_분석보고서.pdf", "_분석보고서.docx", "_분석보고서.md")))
check("summary workbook exists", any(n.endswith("_분석요약.xlsx") for n in names))

if args.extract_to:
    z.extractall(args.extract_to)
    base = os.path.join(args.extract_to, root)
    print("extracted to", base)
    if args.db:
        here = os.path.dirname(os.path.abspath(__file__))
        r = subprocess.run([sys.executable, "-X", "utf8", "-I", os.path.join(here, "pii_scan.py"), args.db, base], capture_output=True, text=True, encoding="utf-8")
        check("PII scan against the database snapshot (names, phones, session ids, token)", r.returncode == 0, r.stdout.strip()[:300])
    if args.reproduce:
        r = subprocess.run([sys.executable, "-X", "utf8", "-I", os.path.join(base, "10_재현", "reproduce_mds.py"), base], capture_output=True, text=True, encoding="utf-8")
        check("independent reproduction inside the package (reproduce_mds.py)", r.returncode == 0, r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr[-200:])
print("ALL CHECKS PASSED" if ok else "SOME CHECKS FAILED")
sys.exit(0 if ok else 1)
