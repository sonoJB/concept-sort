"""Independent numpy implementation of 2D nonmetric SMACOF (secondary ties, sum d^2 = n(n-1)/2 normalisation).
Written separately from the TypeScript engine (different PAVA, different Guttman transform, integer tie groups).
Usage: python -I crossval.py <inputs_dir_with_ts_and_S_json> <out_json>"""
import json, sys, numpy as np

d_in, out = sys.argv[1], sys.argv[2]

def groups_from_S(S):
    n = S.shape[0]; iu = np.triu_indices(n, 1)
    s = S[iu]
    # ascending dissimilarity == descending co-occurrence count
    levels = sorted(set(s.tolist()), reverse=True)
    return iu, s, [np.where(s == lv)[0] for lv in levels]

def pava_groups(y, w):
    # classic pool-adjacent-violators on blocks (lists), independent of the TS stack version
    blocks = [[y[i], w[i], 1] for i in range(len(y))]
    i = 0
    while i < len(blocks) - 1:
        if blocks[i][0] > blocks[i + 1][0] + 0.0:
            a, b = blocks[i], blocks[i + 1]
            ww = a[1] + b[1]
            blocks[i] = [(a[0] * a[1] + b[0] * b[1]) / ww, ww, a[2] + b[2]]
            del blocks[i + 1]
            i = max(i - 1, 0)
        else:
            i += 1
    out_ = []
    for v, _, c in blocks: out_ += [v] * c
    return np.array(out_)

def state(X, iu, grp, q):
    diff = X[iu[0]] - X[iu[1]]
    d = np.sqrt((diff ** 2).sum(1))
    gm = np.array([d[g].mean() for g in grp]); gw = np.array([len(g) for g in grp], float)
    fit_g = pava_groups(gm, gw)
    dh = np.empty_like(d)
    for g, v in zip(grp, fit_g): dh[g] = v
    star = dh.copy()
    dh = dh * np.sqrt(q / (dh ** 2).sum())
    raw = ((dh - d) ** 2).sum()
    return d, dh, star, raw

def guttman(X, iu, d, dh):
    n = X.shape[0]
    B = np.zeros((n, n))
    ratio = np.where(d > 0, dh / np.where(d > 0, d, 1), 0.0)
    B[iu] = -ratio; B = B + B.T
    B[np.diag_indices(n)] = -B.sum(1)
    Xn = B @ X / n
    return Xn - Xn.mean(0)

def run(X0, iu, grp, q, eps, max_iter, trace=None, cont=False):
    X = X0 - X0.mean(0); prev = trace[-1] if trace else None; trace = list(trace) if trace else []
    it = 0
    while True:
        d, dh, star, raw = state(X, iu, grp, q)
        if cont and it == 0:
            prev = raw
        else:
            trace.append(raw)
            if prev is not None:
                rel = (prev - raw) / prev
                if rel < -1e-9: return X, "OBJECTIVE_INCREASED", len(trace), trace, rel
                if rel <= eps: return X, "CONVERGED", len(trace), trace, rel
            prev = raw
        it += 1
        if it > max_iter: return X, "MAX_ITER", len(trace), trace, None
        X = guttman(X, iu, d, dh)

def metrics(X, iu, grp, q):
    d, dh, star, raw = state(X, iu, grp, q)
    s1 = np.sqrt(((star - d) ** 2).sum() / (d ** 2).sum())
    r = np.corrcoef(dh, d)[0, 1]
    return dict(raw=raw, stress1=s1, sqrt_raw_over_q=np.sqrt(raw / q), v1_def=np.sqrt(raw / (d ** 2).sum()), rsq=r * r)

def procrustes_rms(A, B):
    A = A - A.mean(0); B = B - B.mean(0)
    U, s, Vt = np.linalg.svd(B.T @ A)
    R = U @ Vt
    diff = A - B @ R
    return float(np.sqrt((diff ** 2).sum() / len(A))), float(np.sqrt((A ** 2).sum() / len(A)))

res = {}
for k in ["KR", "JP", "ALL"]:
    ts = json.load(open(f"{d_in}/ts_v2_{k}.json")); Sd = json.load(open(f"{d_in}/input_verification_{k}_S.json"))
    S = np.array(Sd["S"]); n = S.shape[0]; q = n * (n - 1) / 2
    iu, s, grp = groups_from_S(S)
    r = {"N": Sd["N"], "tie_groups": len(grp)}
    Xts = np.array(ts["coordinates"])
    # (c) recompute TS final metrics independently
    m = metrics(Xts, iu, grp, q); ev = ts["evaluation"]
    r["recomputed_from_TS_coordinates"] = {kk: float(v) for kk, v in m.items()}
    r["TS_reported"] = {"raw": ev["rawStress"], "stress1": ev["stress1"], "sqrt_raw_over_q": ev["stressNormalizedSqrt"], "v1_def": ev["stress1V1Definition"], "rsq": ev["rsq"]}
    r["max_abs_metric_diff"] = max(abs(m["raw"] - ev["rawStress"]), abs(m["stress1"] - ev["stress1"]), abs(m["sqrt_raw_over_q"] - ev["stressNormalizedSqrt"]), abs(m["v1_def"] - ev["stress1V1Definition"]), abs(m["rsq"] - ev["rsq"]))
    # (a) same start configuration -> same trajectory?
    X0 = np.array(ts["selectedStart"]).reshape(n, 2)
    Xp, reason, iters, trace, rel = run(X0, iu, grp, q, 1e-9, 10000)
    Xs, reason2, iters2, trace2, rel2 = run(Xp, iu, grp, q, 1e-12, 20000, trace, cont=True)
    tmain = ts["selected"]["main"]
    r["same_start"] = {"py_main": {"reason": reason, "iterations": iters, "raw": float(trace[-1])}, "ts_main": tmain,
        "py_strict": {"reason": reason2, "extra_iterations": iters2 - iters, "raw": float(trace2[-1]), "final_rel_change": rel2}, "ts_strict": ts["selected"]["strict"],
        "raw_trace_first5_py": [float(x) for x in trace[:5]], "raw_trace_first5_ts": ts["trace"]["rawStress"][:5],
        "max_abs_raw_diff_over_common_prefix": float(max(abs(a - b) for a, b in zip(trace2, ts["trace"]["rawStress"]))),
        "coord_max_abs_diff_no_alignment": float(np.abs(Xs - Xts).max())}
    # (b) independent multistart with numpy's RNG (different starts than TS)
    rng = np.random.default_rng(12345); cands = []
    for t in range(64):
        X0r = rng.uniform(-1, 1, (n, 2))
        Xr, rs, itr, trr, rl = run(X0r, iu, grp, q, 1e-9, 10000)
        cands.append((trr[-1], rs, itr, Xr))
    conv = [c for c in cands if c[1] == "CONVERGED"]
    best = min(conv, key=lambda c: c[0])
    Xb, rb, ib, trb, relb = run(best[3], iu, grp, q, 1e-12, 20000, [best[0]], cont=True)
    rms, scale = procrustes_rms(Xb, Xts)
    mb = metrics(Xb, iu, grp, q)
    raws = np.array([c[0] for c in conv])
    r["python_multistart"] = {"starts": 64, "converged": len(conv), "reasons": {x: sum(1 for c in cands if c[1] == x) for x in {c[1] for c in cands}},
        "best_raw_after_strict": float(mb["raw"]), "best_stress1": float(mb["stress1"]), "best_rsq": float(mb["rsq"]),
        "ts_best_raw": ev["rawStress"], "raw_diff_py_minus_ts": float(mb["raw"] - ev["rawStress"]),
        "procrustes_rms_vs_ts": rms, "config_rms_size": scale, "procrustes_relative": rms / scale,
        "py_raw_min_median_max_converged": [float(raws.min()), float(np.median(raws)), float(raws.max())],
        "n_starts_within_1e-6_rel_of_best": int((raws <= raws.min() * (1 + 1e-6)).sum())}
    # TS starts: how many reach the best?
    tr = np.array([x["rawStress"] for x in ts["starts"] if x["reason"] == "CONVERGED"])
    r["ts_starts_within_1e-6_rel_of_best"] = int((tr <= tr.min() * (1 + 1e-6)).sum()); r["ts_starts_converged"] = int(len(tr))
    # also confirm that stationarity relation holds
    r["stress1_minus_sqrt_raw_over_q_at_solution"] = float(m["stress1"] - m["sqrt_raw_over_q"])
    res[k] = r
json.dump(res, open(out, "w"), indent=1)
print(json.dumps(res, indent=1))
