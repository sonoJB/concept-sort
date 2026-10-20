#!/usr/bin/env python3
"""Re-draws the recommended-solution concept maps from the STORED coordinates / cluster membership / proposed names with the
package figure code and compares them pixel by pixel with the PNG files that went into the Word draft.
  python -X utf8 verify_figures.py --bundles-dir DIR --figures-json _figures_used.json --repo-scripts scripts/package
"""
import argparse
import json
import os
import sys
import tempfile

import numpy as np
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("--bundles-dir", required=True)
ap.add_argument("--figures-json", required=True)
ap.add_argument("--repo-scripts", required=True)
a = ap.parse_args()
sys.path.insert(0, a.repo_scripts)
import figures as F  # noqa: E402
from common import SCOPE_LABEL_KO  # noqa: E402

used = json.load(open(a.figures_json, encoding="utf-8"))
ok = True
for sc, path in used.items():
    b = json.load(open(os.path.join(a.bundles_dir, f"bundle_{sc}_production.json"), encoding="utf-8"))["bundle"]
    prop = b["naming"]["proposal"]
    k = prop["recommendedK"]
    sol = next(s for s in b["analysis"]["solutions"] if s["k"] == k)
    names = {c["cluster"]: c["nameKo"] for c in prop["solution"]["clusters"]}
    coords = np.array(b["analysis"]["primary"]["coordinates"])
    label = SCOPE_LABEL_KO[sc]
    fig = F.draw_map(coords, sol["labels"], sol["clusters"], names, f"{label} 개념도 (2차원, {k}군집 — 자동 제안명)")
    with tempfile.TemporaryDirectory() as d:
        F.save_all(fig, os.path.join(d, "x"), formats=("png",))
        new = np.array(Image.open(os.path.join(d, "x.png")).convert("RGB"))
    old = np.array(Image.open(path).convert("RGB"))
    same = new.shape == old.shape and bool((new == old).all())
    diff = int((new != old).any(axis=2).sum()) if new.shape == old.shape else -1
    print(f"{sc}: shape {old.shape}, identical pixels: {same}, differing pixels: {diff}")
    ok &= same
    # stored membership of the drawn solution equals the proposal signature
    sig_ok = ",".join(str(x) for x in sol["labels"]) == prop["solution"]["signature"]
    print(f"   labels == proposal signature: {sig_ok}")
    ok &= sig_ok
sys.exit(0 if ok else 1)
