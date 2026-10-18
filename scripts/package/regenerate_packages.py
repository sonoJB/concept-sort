#!/usr/bin/env python3
"""Recreates the three analysis packages from the STORED analysis results of a running application and (optionally)
registers them again. Used after a database restore when a package file is missing (or to prove that the stored
packages can be rebuilt).

  python -X utf8 regenerate_packages.py --base-url URL --slug SLUG --token-env ENVVAR --db RESTORED.db
         --repo REPO --evidence EVIDENCE_DIR --out OUT [--upload] [--compare-stored]

The admin token is read from the environment variable NAMED by --token-env and is never printed.
Steps: overview -> official run ids -> bundles (API) -> pseudonymous participant export from --db (the restored database,
read-only) -> build_packages.py (deterministic) -> optional comparison with the packages the application serves ->
optional upload (PUT, the server re-verifies manifest, fingerprints, hashes and personal data).

Comparison reports separately: (1) whether the ZIP files are byte-identical (SHA-256 of the ZIP), and (2) when they are
not, which internal files differ, grouped as analysis content (data, figures, reports — compared byte for byte),
reproduction tooling (copies of the build code) and the index files that list every hash. With the deterministic builder
and the same inputs and code the ZIPs are identical; a changed tool script changes the ZIP hash and the index files but
not the analysis content."""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile

ap = argparse.ArgumentParser()
ap.add_argument("--base-url", required=True)
ap.add_argument("--slug", required=True)
ap.add_argument("--token-env", required=True)
ap.add_argument("--db", required=True)
ap.add_argument("--repo", required=True)
ap.add_argument("--evidence", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--upload", action="store_true")
ap.add_argument("--compare-stored", action="store_true")
args = ap.parse_args()

token = os.environ.get(args.token_env)
if not token:
    sys.exit(f"environment variable {args.token_env} is not set")
base = args.base_url.rstrip("/") + f"/api/projects/{args.slug}/analysis"
sha = lambda b: hashlib.sha256(b).hexdigest()


def call(path, method="GET", data=None, headers=None):
    req = urllib.request.Request(base + path, data=data, method=method, headers={"Authorization": f"Bearer {token}", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


os.makedirs(args.out, exist_ok=True)
bdir = os.path.join(args.out, "bundles")
os.makedirs(bdir, exist_ok=True)
st, body, _ = call("/overview")
ov = json.loads(body)
runs = {}
for scope in ("KR", "JP", "ALL"):
    off = ov["scopes"][scope]["official"]
    if not off:
        sys.exit(f"{scope}: no official result in the application")
    runs[scope] = off["id"]
    st, body, _ = call(f"/runs/{off['id']}/bundle")
    if st != 200:
        sys.exit(f"{scope}: bundle request failed ({st})")
    open(os.path.join(bdir, f"bundle_{scope}.json"), "wb").write(body)
print("official runs:", {k: v[:10] + "…" for k, v in runs.items()})

raw = os.path.join(args.out, "raw.json")
subprocess.run(["npx", "tsx", "scripts/mds/export-raw.ts", args.db, raw], cwd=args.repo, check=True, shell=(os.name == "nt"))
pk = os.path.join(args.out, "packages")
if os.path.exists(pk):
    shutil.rmtree(pk)
os.makedirs(pk)
subprocess.run([sys.executable, "-X", "utf8", "-I", os.path.join(args.repo, "scripts", "package", "build_packages.py"), "--bundles", bdir, "--raw", raw, "--out", pk, "--repo", args.repo, "--evidence", args.evidence], check=True)
zips = sorted(f for f in os.listdir(pk) if f.endswith(".zip"))
report = {"regenerated": zips, "comparison": {}, "upload": {}}
scope_of = {}
for z in zips:
    m = json.loads(zipfile.ZipFile(os.path.join(pk, z)).read(z[:-4] + "/manifest.json"))
    scope_of[m["scope"]] = (z, m)

if args.compare_stored:
    for scope, (z, m) in scope_of.items():
        st, stored, hdr = call(f"/runs/{runs[scope]}/package")
        new = open(os.path.join(pk, z), "rb").read()
        c = {"stored_available": st == 200}
        if st == 200:
            c["zip_sha256_identical"] = sha(stored) == sha(new)
            if not c["zip_sha256_identical"]:
                za, zb = zipfile.ZipFile(__import__("io").BytesIO(stored)), zipfile.ZipFile(__import__("io").BytesIO(new))
                na, nb = set(za.namelist()), set(zb.namelist())
                c["only_in_stored"] = sorted(na - nb)[:10]
                c["only_in_regenerated"] = sorted(nb - na)[:10]
                diff = [n for n in na & nb if za.read(n) != zb.read(n)]
                diff += [n for n in (nb - na)] + [n for n in (na - nb)]

                def kind(n):
                    rel = n.split("/", 1)[1] if "/" in n else n
                    if rel in ("manifest.json", "SHA256SUMS.txt", "00_안내/파일목록.csv"):
                        return "index"  # lists the hashes of everything else, so it changes whenever anything changes
                    if rel.startswith("10_재현/package-builder/") or rel.startswith("10_재현/ts-source/") or rel.startswith("10_재현/verification-scripts/"):
                        return "reproduction_tooling"  # copies of the code at build time
                    return "analysis_content"

                c["differing_by_kind"] = {k: sorted(n for n in diff if kind(n) == k)[:20] for k in ("analysis_content", "reproduction_tooling", "index")}
                c["analysis_content_identical"] = not c["differing_by_kind"]["analysis_content"]
        report["comparison"][scope] = c

if args.upload:
    for scope, (z, m) in scope_of.items():
        data = open(os.path.join(pk, z), "rb").read()
        st, body, _ = call(f"/runs/{runs[scope]}/package", "PUT", data, {"x-package-sha256": sha(data), "Content-Type": "application/zip"})
        report["upload"][scope] = {"status": st, "response": json.loads(body) if body else None}
json.dump(report, open(os.path.join(args.out, "regenerate_report.json"), "w"), ensure_ascii=False, indent=1)
print(json.dumps(report, ensure_ascii=False, indent=1))
