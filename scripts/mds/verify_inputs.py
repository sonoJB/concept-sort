"""Independent (non-application) recount of co-occurrence frequencies from the raw DB snapshot, compared with
the official Excel matrices. Read-only. Usage: python verify_inputs.py <db> <matrices_dir> <out_json>"""
import sqlite3, sys, glob, json, itertools
import numpy as np, openpyxl

db, mdir, out = sys.argv[1], sys.argv[2], sys.argv[3]
con = sqlite3.connect("file:" + db.replace("\\", "/") + "?mode=ro", uri=True)
stm = con.execute('select id from Statement order by "order"').fetchall()
sid = [r[0] for r in stm]; idx = {s: k for k, s in enumerate(sid)}
n_st = len(sid)
sess = con.execute("select id, countryCode, dataRole from SortSession").fetchall()
groups = {}
for sidn, gid, st in con.execute("select g.sortSessionId, g.id, i.statementId from SortGroup g join SortGroupItem i on i.groupId=g.id"):
    groups.setdefault(sidn, {}).setdefault(gid, []).append(st)

report = {"statements": n_st, "sessions_total": len(sess)}
main = [(s, c) for s, c, r in sess if r == "MAIN"]
report["main_by_country"] = {k: sum(1 for _, c in main if c == k) for k in sorted({c for _, c in main}, key=str)}
report["non_main_by_role"] = {}
for s, c, r in sess:
    if r != "MAIN": report["non_main_by_role"][r] = report["non_main_by_role"].get(r, 0) + 1

def cooc(session_ids):
    S = np.zeros((n_st, n_st), dtype=int)
    problems = []
    for s in session_ids:
        gs = groups.get(s, {})
        flat = [x for g in gs.values() for x in g]
        if len(flat) != len(set(flat)): problems.append((s, "duplicate placement"))
        if set(flat) != set(sid): problems.append((s, "not all statements placed exactly once (placed %d)" % len(set(flat))))
        for items in gs.values():
            ids = sorted(idx[x] for x in set(items))
            for a, b in itertools.combinations(ids, 2):
                S[a, b] += 1; S[b, a] += 1
    return S, problems

scopes = {"KR": [s for s, c in main if c == "KR"], "JP": [s for s, c in main if c == "JP"]}
scopes["ALL"] = scopes["KR"] + scopes["JP"]
mats, probs = {}, {}
for k, v in scopes.items():
    mats[k], probs[k] = cooc(v)
report["scope_N"] = {k: len(v) for k, v in scopes.items()}
report["problems"] = {k: p for k, p in probs.items()}
report["ALL_equals_KR_plus_JP"] = bool((mats["ALL"] == mats["KR"] + mats["JP"]).all())

files = {"KR": "*한국*", "JP": "*일본*", "ALL": "*전체*"}
def sheet(f, name):
    rows = list(openpyxl.load_workbook(f, read_only=True, data_only=True)[name].iter_rows(values_only=True))
    ids = [r[0] for r in rows[1:]]; head = list(rows[0][1:])
    M = np.array([[float(x) for x in r[1:]] for r in rows[1:]])
    return ids, head, M
sidmap = None
for k in ["KR", "JP", "ALL"]:
    f = glob.glob(mdir + "/" + files[k])[0]
    ids, head, Z = sheet(f, "빈도행렬")
    ids2, head2, D = sheet(f, "분석용_유사성빈도_대각선N")
    ids3, head3, P = sheet(f, "비율행렬")
    S = mats[k]; N = len(scopes[k])
    off = ~np.eye(n_st, dtype=bool)
    rep = {
        "excel_ids_equal_header": ids == head == ids2 == head2 == ids3 == head3,
        "excel_ids_S01_to_S47_in_order": ids == ["S%02d" % (i + 1) for i in range(n_st)],
        "excel_shape": list(Z.shape),
        "recount_vs_excel_zero_diag_offdiag_max_abs_diff": float(np.abs(S[off] - Z[off]).max()),
        "excel_zero_diag_all_zero": bool((np.diag(Z) == 0).all()),
        "recount_vs_excel_diagN_offdiag_max_abs_diff": float(np.abs(S[off] - D[off]).max()),
        "excel_diagN_diag_equals_N": bool((np.diag(D) == N).all()),
        "excel_proportion_vs_recount_over_N_max_abs_diff": float(np.abs(S[off] / N - P[off]).max()),
        "symmetric_recount": bool((S == S.T).all()),
        "symmetric_excel_zero_diag": bool((Z == Z.T).all()),
        "min_offdiag": int(S[off].min()), "max_offdiag": int(S[off].max()),
        "in_range_0_to_N": bool(((S[off] >= 0) & (S[off] <= N)).all()),
        "pairs_total": int(n_st * (n_st - 1) // 2),
        "pairs_never_together": int((S[np.triu_indices(n_st, 1)] == 0).sum()),
        "pairs_always_together": int((S[np.triu_indices(n_st, 1)] == N).sum()),
        "distinct_offdiag_levels": int(len(np.unique(S[off]))),
    }
    report[k] = rep
    # dissimilarity delta = 1 - S/N, diag 0
    Dm = 1 - S / N; np.fill_diagonal(Dm, 0)
    report[k]["dissimilarity_range"] = [float(Dm[off].min()), float(Dm[off].max())]
    report[k]["dissimilarity_symmetric"] = bool(np.allclose(Dm, Dm.T))
    json.dump({"N": N, "S": S.tolist()}, open(out.replace(".json", "_" + k + "_S.json"), "w"))
json.dump(report, open(out, "w"), indent=1, ensure_ascii=False)
print(json.dumps(report, indent=1, ensure_ascii=False))
