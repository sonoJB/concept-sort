#!/usr/bin/env python3
"""Checks that every figure in the Word draft IS the PNG file of the registered analysis package (byte for byte), that each figure
appears once with its package caption, and that the PNGs are real 600 dpi renders (3,780 px wide).

  python -X utf8 verify_figures_embedded.py --docx FILE --figures-root DIR_WITH_EXTRACTED_PACKAGES --out report.json
"""
import argparse
import csv
import glob
import hashlib
import json
import os
import sys
import zipfile

from docx import Document
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("--docx", required=True)
ap.add_argument("--figures-root", required=True)
ap.add_argument("--out", required=True)
a = ap.parse_args()

pkg_png = {}
captions = []
for root in glob.glob(os.path.join(a.figures_root, "*")):
    for f in glob.glob(os.path.join(root, "08_그림", "*.png")):
        pkg_png[hashlib.sha256(open(f, "rb").read()).hexdigest()] = os.path.basename(f)
    lst = os.path.join(root, "08_그림", "그림목록.csv")
    if os.path.exists(lst):
        captions += [(r[0], r[2]) for r in list(csv.reader(open(lst, encoding="utf-8-sig")))[1:]]

z = zipfile.ZipFile(a.docx)
media = [n for n in z.namelist() if n.startswith("word/media/")]
res = []
used = []
for n in media:
    data = z.read(n)
    h = hashlib.sha256(data).hexdigest()
    ok = h in pkg_png
    with Image.open(__import__("io").BytesIO(data)) as im:
        w = im.width
    res.append({"media": n, "matches_package_png": ok, "package_file": pkg_png.get(h), "width_px": w, "width_ok": w == 3780})
    used.append(pkg_png.get(h))
text = "\n".join(p.text for p in Document(a.docx).paragraphs)
cap_ok = []
for fname in used:
    c = next((c for f, c in captions if f + ".png" == fname), None)
    cap_ok.append(bool(c) and c[:30] in text)
ok = all(r["matches_package_png"] and r["width_ok"] for r in res) and len(set(used)) == len(used) and all(cap_ok)
json.dump({"docx": os.path.basename(a.docx), "figures": len(res), "all_identical_to_package_png": all(r["matches_package_png"] for r in res), "unique": len(set(used)) == len(used), "all_3780px": all(r["width_ok"] for r in res), "captions_from_package_found": all(cap_ok), "items": res}, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"{len(res)} embedded figures; identical to package PNG: {sum(r['matches_package_png'] for r in res)}; 3780 px: {sum(r['width_ok'] for r in res)}; captions found: {sum(cap_ok)}; unique: {len(set(used)) == len(used)}")
sys.exit(0 if ok else 1)
