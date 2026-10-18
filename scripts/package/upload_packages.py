"""Registers built package ZIPs with the application (PUT .../runs/<runId>/package). The run id is read from each ZIP's
manifest; the server re-verifies the manifest, fingerprints, per-file SHA-256 and scans for personal data.
The admin token is read from the environment variable NAMED by --token-env and is never printed.
  python upload_packages.py --base-url URL --slug SLUG --token-env VAR <zip> [<zip> ...]"""
import argparse
import hashlib
import json
import os
import sys
import urllib.request
import zipfile

ap = argparse.ArgumentParser()
ap.add_argument("--base-url", required=True)
ap.add_argument("--slug", required=True)
ap.add_argument("--token-env", required=True)
ap.add_argument("zips", nargs="+")
a = ap.parse_args()
token = os.environ.get(a.token_env)
if not token:
    sys.exit(f"environment variable {a.token_env} is not set")
ok = True
for path in a.zips:
    z = zipfile.ZipFile(path)
    root = z.namelist()[0].split("/")[0]
    manifest = json.loads(z.read(f"{root}/manifest.json"))
    data = open(path, "rb").read()
    sha = hashlib.sha256(data).hexdigest()
    req = urllib.request.Request(
        f"{a.base_url.rstrip('/')}/api/projects/{a.slug}/analysis/runs/{manifest['runId']}/package",
        data=data,
        method="PUT",
        headers={"Authorization": f"Bearer {token}", "x-package-sha256": sha, "Content-Type": "application/zip"},
    )
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            body = json.loads(r.read())
            print(manifest["scope"], r.status, {k: body.get(k) for k in ("ok", "filename", "sha256", "byteSize", "files")})
    except urllib.error.HTTPError as e:
        ok = False
        print(manifest["scope"], e.code, e.read().decode("utf-8")[:300])
sys.exit(0 if ok else 1)
