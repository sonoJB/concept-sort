"""Shared helpers for building the per-scope analysis packages (read-only consumers of a stored result bundle)."""
import hashlib
import json
import math
import os

import numpy as np

SCOPE_NAME_KO = {"KR": "한국", "JP": "일본", "ALL": "한국-일본전체"}
SCOPE_LABEL_KO = {"KR": "한국", "JP": "일본", "ALL": "한국–일본 전체"}

CLUSTER_COLORS = ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00", "#56B4E9", "#7A7A00", "#222222", "#8C564B", "#7F7F7F"]
CLUSTER_MARKERS = ["o", "s", "^", "D", "v", "P", "p", "*", "h", "o"]  # circle, square, triangle, diamond, triangle-down, plus, pentagon, star, hexagon, ring
RING_INDEX = 9
GRAY_LEVELS = ["#111111", "#555555", "#888888", "#333333", "#aaaaaa", "#666666", "#999999", "#444444", "#bbbbbb", "#777777"]
HATCHES = ["//", "\\\\", "xx", "..", "++", "--", "oo", "**", "||", ""]


def cluster_style(c):
    i = (c - 1) % len(CLUSTER_COLORS)
    return CLUSTER_COLORS[i], CLUSTER_MARKERS[i], i == RING_INDEX


def fmt(v, d=4):
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return "계산 불가"
    return f"{v:.{d}f}"


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def canonicalize(v):
    if v is None or isinstance(v, (str, bool)):
        return v
    if isinstance(v, (int, float)):
        if isinstance(v, float) and not math.isfinite(v):
            raise ValueError("non-finite number")
        return 0 if (isinstance(v, float) and v == 0 and math.copysign(1, v) < 0) else v
    if isinstance(v, list):
        return [canonicalize(x) for x in v]
    if isinstance(v, dict):
        return {k: canonicalize(v[k]) for k in sorted(v.keys())}
    raise TypeError(type(v))


def js_number_repr(x):
    """JSON.stringify number text as JavaScript would print it (ints without .0, shortest round-trip floats)."""
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, int):
        return str(x)
    if x == int(x) and abs(x) < 1e21:
        return str(int(x))
    return repr(x)


def js_stringify(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return js_number_repr(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        return "[" + ",".join(js_stringify(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + js_stringify(v[k]) for k in v) + "}"
    raise TypeError(type(v))


def canonical_hash(v):
    return hashlib.sha256(js_stringify(canonicalize(v)).encode("utf-8")).hexdigest()


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_text(path, text, bom=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(("﻿" if bom else "") + text)


def write_csv(path, header, rows):
    import csv

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, lineterminator="\r\n")
        w.writerow(header)
        for r in rows:
            w.writerow(["" if x is None else x for x in r])


def derive(S, N):
    S = np.asarray(S, dtype=float)
    P = S / N
    D = N - S
    delta = 1 - S / N
    np.fill_diagonal(delta, 0)
    np.fill_diagonal(D, 0)
    return P, D, delta


def sid(i):
    return f"S{i + 1:02d}"


FIXED_ZIP_TIME = (2026, 1, 1, 0, 0, 0)


def rewrite_zip_deterministic(path):
    """Rewrites a ZIP-based file (xlsx/docx) with fixed entry timestamps so that identical content gives identical bytes."""
    import zipfile

    tmp = path + ".tmp"
    with zipfile.ZipFile(path) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zout:
        for info in zin.infolist():
            zi = zipfile.ZipInfo(info.filename, date_time=FIXED_ZIP_TIME)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            zout.writestr(zi, zin.read(info.filename))
    os.replace(tmp, path)
