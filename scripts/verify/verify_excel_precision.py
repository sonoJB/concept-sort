#!/usr/bin/env python3
"""Numerical-precision check of an analysis workbook (a package's 01_요약/*_분석자료.xlsx), in three separated stages.

  python -X utf8 scripts/verify/verify_excel_precision.py --package-dir DIR --work-dir WORK --out report.json [--scope KR|JP|ALL]

The original workbook is never opened for writing: Excel opens and saves only COPIES placed in --work-dir.

Stage A  numbers stored inside the generated XLSX (read as XML by openpyxl, no Excel involved)  vs  the package's reference CSV files.
Stage B  the same workbook COPY opened in real Excel (Application.CalculateFull) vs stage A and the CSV files; formula results too.
Stage C  the copy saved by Excel as a separate file (SaveAs) and read again  vs  stage A and the CSV files.

Reported per table group: cells compared, cells bit-identical, max absolute and max relative difference (relative = |a-b|/|b|, b != 0),
and how many values change when rounded to 3 decimals (the precision used in the report tables).
No claim of bit-identity is made except where the numbers below show it.
"""
import argparse
import csv
import glob
import json
import math
import os
import shutil
import sys
import time

import numpy as np
import openpyxl

ap = argparse.ArgumentParser()
ap.add_argument("--package-dir", required=True)
ap.add_argument("--work-dir", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--no-excel", action="store_true")
a = ap.parse_args()

root = a.package_dir
if not os.path.exists(os.path.join(root, "manifest.json")):
    root = glob.glob(os.path.join(root, "*"))[0]
src = glob.glob(os.path.join(root, "01_요약", "*_분석자료.xlsx"))[0]
os.makedirs(a.work_dir, exist_ok=True)
copy_b = os.path.join(a.work_dir, "B_excel_open_recalc_copy.xlsx")
copy_c = os.path.join(a.work_dir, "C_excel_saved_copy.xlsx")
shutil.copyfile(src, copy_b)

report = {"workbook": os.path.basename(src), "tables": {}, "formula": {}, "excel": {}, "notes": []}


def read_csv(rel):
    with open(os.path.join(root, rel), encoding="utf-8-sig", newline="") as f:
        return list(csv.reader(f))


def tofloat(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


# --- the numeric tables: (group, sheet, header_row, csv, [(sheet header, csv header)]) or matrix
MATS = [
    ("행렬_정수(S)", "S_유사성빈도", "04_행렬/S_집단유사성빈도_대각선N.csv"),
    ("행렬_비율(P)", "P_유사성비율", "04_행렬/P_유사성비율_대각선1.csv"),
    ("행렬_정수(D)", "D_비유사성빈도", "04_행렬/D_비유사성빈도_대각선0.csv"),
    ("행렬_비율(δ)", "delta_정규화비유사성", "04_행렬/delta_비유사성비율_MDS입력_대각선0.csv"),
    ("행렬_정수(기존 대각0)", "기존_빈도행렬_대각0(유사성)", "04_행렬/기존표시형식_빈도행렬_대각선0.csv"),
]
TABLES = [
    ("좌표", "좌표·군집(추천)", 2, "05_MDS/좌표_2D.csv", [("차원 1", "차원 1"), ("차원 2", "차원 2")]),
    ("차원별 지표", "차원별_지표", 1, "05_MDS/차원비교_1-5D.csv", [("Stress-1", "Stress-1"), ("√(raw/q)", "√(raw/q)"), ("raw stress", "raw stress"), ("RSQ", "RSQ")]),
    ("군집 수별 지표", "군집수별_지표", 1, "07_군집/군집후보비교.csv", [("최소 군집 크기", "최소 군집 크기"), ("지도 실루엣 평균", "지도 실루엣 평균"), ("δ 실루엣 평균", "δ 실루엣 평균"), ("군집 간 제곱합 비율", "군집 간 제곱합 비율"), ("k+1→k 병합 높이", "k+1→k 병합 높이")]),
    ("Ward 병합 이력", "Ward병합이력", 1, "07_군집/병합이력_병합비용.csv", [("병합 높이", "병합 높이"), ("병합 비용(군집 내 제곱합 증가량)", "병합 비용(군집 내 제곱합 증가량)")]),
    ("문항쌍 진단", "문항쌍_진단", 2, "06_진단/쌍진단_1081.csv", None),  # all numeric columns, by position 3..11
    ("문항별 stress 기여", "문항별_stress기여", 1, "06_진단/점별_stress기여.csv", [("stress 기여(Σ_j 잔차²)", "stress 기여(Σ_j 잔차²)"), ("전체 raw stress 대비 비율(%)", "전체 raw stress 대비 비율(%)")]),
    ("분할 반분 전체값", "분할반분_전체값", 1, "09_보완분석/반복분할_신뢰도_전체값.csv", [("원상관 r", "원상관 r"), ("Spearman–Brown", "Spearman–Brown")]),
]


def grid_from_openpyxl(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    return {ws.title: [[c.value for c in r] for r in ws.iter_rows()] for ws in wb.worksheets}


def cmp_arrays(x, y):
    """x: values under test, y: reference. returns dict of stats"""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    d = np.abs(x - y)
    nz = y != 0
    rel = np.zeros_like(d)
    rel[nz] = d[nz] / np.abs(y[nz])
    r3x, r3y = np.round(x, 3), np.round(y, 3)
    return {"cells": int(x.size), "bit_identical": int(np.sum(x == y)), "max_abs": float(d.max()) if x.size else 0.0, "max_rel": float(rel.max()) if x.size else 0.0, "changed_when_rounded_to_3_decimals": int(np.sum(r3x != r3y))}


def extract(grid, group):
    """returns {key: (array_of_values)} for the numeric tables from a {sheet: rows} grid"""
    out = {}
    for g, sh, rel in MATS:
        rows = grid[sh]
        n = 47
        out[g] = np.array([[tofloat(rows[1 + i][1 + j]) for j in range(n)] for i in range(n)], dtype=float)
    for g, sh, hr, rel, pairs in TABLES:
        rows = grid[sh]
        hdr = rows[hr - 1]
        data = [r for r in rows[hr:] if r[0] is not None and r[0] != ""]
        if pairs is None:
            cols = list(range(2, 11))
        else:
            cols = [hdr.index(p[0]) for p in pairs]
        arr = np.array([[tofloat(r[c]) if tofloat(r[c]) is not None else np.nan for c in cols] for r in data], dtype=float)
        out[g] = arr
    return out


def csv_reference():
    ref = {}
    for g, sh, rel in MATS:
        rows = read_csv(rel)
        ref[g] = np.array([[float(x) for x in r[1:]] for r in rows[1:]], dtype=float)
    for g, sh, hr, rel, pairs in TABLES:
        rows = read_csv(rel)
        hdr = rows[0]
        if pairs is None:
            cols = list(range(2, 11))
        else:
            cols = [hdr.index(p[1]) for p in pairs]
        ref[g] = np.array([[tofloat(r[c]) if tofloat(r[c]) is not None else np.nan for c in cols] for r in rows[1:]], dtype=float)
    return ref


ref = csv_reference()
grid_a = grid_from_openpyxl(src)
A = extract(grid_a, "A")


def stage(name, vals, base=None):
    res = {}
    for g in A:
        v = vals[g]
        res[g] = {"vs_csv": cmp_arrays(v, ref[g])}
        if base is not None:
            res[g]["vs_stage_A"] = cmp_arrays(v, A[g])
    return res


report["tables"]["A_xlsx_internal"] = stage("A", A)

# whole-workbook numeric cells (every sheet) for stage B/C self-consistency
numeric_cells_a = {}
for sh, rows in grid_a.items():
    for i, r in enumerate(rows):
        for j, v in enumerate(r):
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                numeric_cells_a[(sh, i, j)] = float(v)
report["excel"]["numeric_cells_in_workbook"] = len(numeric_cells_a)


def whole_workbook_cmp(grid_x):
    xs, ys = [], []
    missing = 0
    for (sh, i, j), v in numeric_cells_a.items():
        try:
            w = grid_x[sh][i][j]
        except (KeyError, IndexError):
            missing += 1
            continue
        if isinstance(w, (int, float)) and not isinstance(w, bool):
            xs.append(float(w))
            ys.append(v)
        else:
            missing += 1
    st = cmp_arrays(xs, ys)
    st["cells_not_numeric_or_missing_after_roundtrip"] = missing
    return st


report["excel"]["A_calc_settings"] = {}
import zipfile, re
with zipfile.ZipFile(src) as z:
    wbxml = z.read("xl/workbook.xml").decode("utf-8")
    m = re.search(r"<calcPr[^>]*>", wbxml)
    report["excel"]["A_calc_settings"]["calcPr_in_xlsx"] = m.group(0) if m else None
    report["excel"]["A_calc_settings"]["precisionAsDisplayed_flag_present"] = bool(m and "fullPrecision=\"0\"" in m.group(0))

# --- formula sheet (stage A cached results)
wb_f = openpyxl.load_workbook(src, data_only=False)
formula_cells = [(ws.title, c.coordinate) for ws in wb_f.worksheets for r in ws.iter_rows() for c in r if c.data_type == "f"]
cached = {(s, c): openpyxl.load_workbook(src, data_only=True)[s][c].value for s, c in formula_cells} if formula_cells else {}
report["formula"]["cells"] = len(formula_cells)
report["formula"]["sheets"] = sorted({s for s, _ in formula_cells})
report["formula"]["cached"] = {f"{s}!{c}": v for (s, c), v in cached.items()}

if not a.no_excel:
    import win32com.client
    import pythoncom

    pythoncom.CoInitialize()
    xl = win32com.client.DispatchEx("Excel.Application")
    xl.Visible = False
    xl.DisplayAlerts = False
    xl.AskToUpdateLinks = False
    try:
        report["excel"]["application"] = {"Version": xl.Version, "Build": str(xl.Build), "Calculation_before_open": int(xl.Calculation)}
        wbk = xl.Workbooks.Open(os.path.abspath(copy_b), 0, False)
        report["excel"]["workbook_PrecisionAsDisplayed"] = bool(wbk.PrecisionAsDisplayed)
        report["excel"]["Calculation_mode"] = int(xl.Calculation)  # -4105 automatic
        t0 = time.time()
        xl.CalculateFull()
        report["excel"]["calculate_full_seconds"] = round(time.time() - t0, 2)

        def grid_from_excel(wbk):
            g = {}
            for ws in wbk.Worksheets:
                name = ws.Name
                nr = len(grid_a[name])
                nc = max(len(r) for r in grid_a[name])
                rng = ws.Range(ws.Cells(1, 1), ws.Cells(nr, nc))
                v = rng.Value2
                if not isinstance(v, tuple):
                    v = ((v,),)
                g[name] = [list(r) for r in v]
            return g

        grid_b = grid_from_excel(wbk)
        # formula results recomputed by Excel
        frs = {}
        for s, c in formula_cells:
            frs[f"{s}!{c}"] = wbk.Worksheets(s).Range(c).Value2
        report["formula"]["excel_recalculated"] = frs
        report["formula"]["formula_text"] = {f"{s}!{c}": wbk.Worksheets(s).Range(c).Formula for s, c in formula_cells}
        errs = []
        for sh, rows in grid_b.items():
            for i, r in enumerate(rows):
                for j, v in enumerate(r):
                    if isinstance(v, int) and not isinstance(v, bool) and v < -2146826000:
                        errs.append((sh, i + 1, j + 1, v))
        report["excel"]["B_error_cells"] = len(errs)
        wbk.SaveCopyAs(os.path.abspath(copy_c))
        wbk.Close(False)
    finally:
        xl.Quit()
        pythoncom.CoUninitialize()

    B = extract(grid_b, "B")
    report["tables"]["B_excel_opened_and_recalculated"] = stage("B", B, base=A)
    report["excel"]["B_whole_workbook_vs_A"] = whole_workbook_cmp(grid_b)
    grid_c = grid_from_openpyxl(copy_c)
    C = extract(grid_c, "C")
    report["tables"]["C_excel_saved_copy_read_back"] = stage("C", C, base=A)
    report["excel"]["C_whole_workbook_vs_A"] = whole_workbook_cmp(grid_c)
    with zipfile.ZipFile(copy_c) as z:
        wbxml = z.read("xl/workbook.xml").decode("utf-8")
        m = re.search(r"<calcPr[^>]*>", wbxml)
        report["excel"]["C_calcPr_in_saved_copy"] = m.group(0) if m else None
    report["excel"]["sha256_original"] = __import__("hashlib").sha256(open(src, "rb").read()).hexdigest()
    report["excel"]["sha256_excel_saved_copy"] = __import__("hashlib").sha256(open(copy_c, "rb").read()).hexdigest()

# effect on the report values / clusters: Ward on the 2-D coordinates from each source (same Ward / cut / silhouette code as the package's reproduce_mds.py)
import itertools


def ward(X):
    cl = {i: [i] for i in range(len(X))}
    nxt = len(X)
    out = []
    while len(cl) > 1:
        best = None
        for p_, q_ in itertools.combinations(sorted(cl), 2):
            na, nb = len(cl[p_]), len(cl[q_])
            inc = na * nb / (na + nb) * ((X[cl[p_]].mean(0) - X[cl[q_]].mean(0)) ** 2).sum()
            if best is None or inc < best[0] - 1e-15:
                best = (inc, p_, q_)
        inc, p_, q_ = best
        cl[nxt] = cl.pop(p_) + cl.pop(q_)
        out.append((min(p_, q_), max(p_, q_), float(np.sqrt(2 * inc))))
        nxt += 1
    return out


def cut(link, k, n):
    parent = {}
    for idx, (l, r, h) in enumerate(link[: n - k]):
        parent[l] = n + idx
        parent[r] = n + idx

    def find_root(x):
        while x in parent:
            x = parent[x]
        return x

    roots, lab = {}, []
    for i in range(n):
        r = find_root(i)
        roots.setdefault(r, len(roots))
        lab.append(roots[r])
    order = []
    for l in lab:
        if l not in order:
            order.append(l)
    return [order.index(l) + 1 for l in lab]


def silhouette(Dm, lab, n):
    lab = np.array(lab)
    kk = lab.max()
    s = np.zeros(n)
    for i in range(n):
        own = np.where(lab == lab[i])[0]
        if len(own) == 1:
            continue
        a_ = Dm[i, own[own != i]].mean()
        b_ = min(Dm[i, np.where(lab == c)[0]].mean() for c in range(1, kk + 1) if c != lab[i])
        s[i] = (b_ - a_) / max(a_, b_)
    return s


mem = read_csv("07_군집/군집소속_k별.csv")
ks = [int(h.split("=")[1]) for h in mem[0][1:]]
stored_lab = {k: [int(r[1 + j]) for r in mem[1:]] for j, k in enumerate(ks)}
sil_csv = {int(r[0]): float(r[3]) for r in read_csv("07_군집/군집후보비교.csv")[1:]}
sil_xlsx = {int(r[0]): float(r[3]) for r in grid_a["군집수별_지표"][1:] if r[0] is not None}
eff = {}
sources = {"A_xlsx_internal": A["좌표"], "csv_as_written": ref["좌표"]}
if not a.no_excel:
    sources["B_excel_opened_and_recalculated"] = B["좌표"]
    sources["C_excel_saved_copy"] = C["좌표"]
n47 = len(A["좌표"])
for nm, xy in sources.items():
    link = ward(xy)
    Dm = np.sqrt(((xy[:, None] - xy[None]) ** 2).sum(2))
    same_all, sil_diff = True, 0.0
    sil_diff_vs_csv = 0.0
    for k in ks:
        lab = cut(link, k, n47)
        same_all &= lab == stored_lab[k]
        sm = float(silhouette(Dm, lab, n47).mean())
        sil_diff = max(sil_diff, abs(sm - sil_xlsx[k]))
        sil_diff_vs_csv = max(sil_diff_vs_csv, abs(round(sm, 6) - sil_csv[k]))
    eff[nm] = {"cluster_membership_equals_stored_for_every_k": bool(same_all), "ks": ks, "max_abs_diff_silhouette_mean_vs_stored(6 decimals stored)": sil_diff, "max_abs_diff_rounded_to_6_decimals_vs_stored_csv": sil_diff_vs_csv}
report["effect_on_clusters"] = eff

json.dump(report, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1, default=str)
print("written", a.out)
