"""External-library comparison (scikit-learn smacof) for the selected 2D solutions.

scikit-learn is NOT part of the analysis; it is installed into a scratch directory only for this check:
    python -m pip install --target <dir> scikit-learn
    python -X utf8 external_check_sklearn.py <dir> <bundle_dir> <out.json>

What is compared, per scope, starting sklearn from the SAME start configuration as the selected solution:
  - sklearn's own final configuration and its reported normalised stress (Stress-1 as sklearn defines it)
  - this analysis' definitions (raw stress with normalised disparities, Kruskal Stress-1, sqrt(raw/q), RSQ) recomputed
    on sklearn's configuration with the independent numpy routines below
  - agreement of the two configurations after orthogonal Procrustes alignment
Differences in tie handling/normalisation/stopping rule are expected to produce small differences; they are reported,
not hidden.
"""
import json
import sys

sys.path.insert(0, sys.argv[1])
import numpy as np  # noqa: E402
import sklearn  # noqa: E402
from sklearn.manifold import smacof  # noqa: E402

bundle_dir, out = sys.argv[2], sys.argv[3]
M32 = 0xFFFFFFFF


def imul(a, b):
    return (a * b) & M32


def mulberry32(seed):
    s = [seed & M32]

    def rng():
        s[0] = (s[0] + 0x6D2B79F5) & M32
        t = s[0]
        t = imul(t ^ (t >> 15), t | 1)
        t = (t ^ ((t + imul(t ^ (t >> 7), t | 61)) & M32)) & M32
        return ((t ^ (t >> 14)) & M32) / 4294967296

    return rng


def start(seed, n):
    rng = mulberry32(seed)
    X = np.array([[-1 + rng() * 2 for _ in range(2)] for _ in range(n)])
    return X - X.mean(0)


def pava(y, w):
    blocks = [[y[i], w[i], 1] for i in range(len(y))]
    i = 0
    while i < len(blocks) - 1:
        if blocks[i][0] > blocks[i + 1][0]:
            a, b = blocks[i], blocks[i + 1]
            ww = a[1] + b[1]
            blocks[i] = [(a[0] * a[1] + b[0] * b[1]) / ww, ww, a[2] + b[2]]
            del blocks[i + 1]
            i = max(i - 1, 0)
        else:
            i += 1
    out_ = []
    for v, _, c in blocks:
        out_ += [v] * c
    return np.array(out_)


def metrics(X, S):
    n = len(X)
    iu = np.triu_indices(n, 1)
    q = n * (n - 1) / 2
    levels = sorted(set(S[iu].tolist()), reverse=True)
    grp = [np.where(S[iu] == lv)[0] for lv in levels]
    d = np.sqrt(((X[iu[0]] - X[iu[1]]) ** 2).sum(1))
    gm = np.array([d[g].mean() for g in grp])
    fit = pava(gm, np.array([len(g) for g in grp], float))
    star = np.empty_like(d)
    for g, v in zip(grp, fit):
        star[g] = v
    dh = star * np.sqrt(q / (star**2).sum())
    raw = float(((dh - d) ** 2).sum())
    return {"raw": raw, "stress1_kruskal": float(np.sqrt(((star - d) ** 2).sum() / (d**2).sum())), "sqrt_raw_over_q": float(np.sqrt(raw / q)), "v1_definition": float(np.sqrt(raw / (d**2).sum())), "rsq": float(np.corrcoef(dh, d)[0, 1] ** 2)}


def procrustes_rel(A, B):
    A = A - A.mean(0)
    B = B - B.mean(0)
    U, s, Vt = np.linalg.svd(B.T @ A)
    R = U @ Vt
    return float(((A - B @ R) ** 2).sum() / (A**2).sum())


res = {"sklearn_version": sklearn.__version__, "numpy_version": np.__version__, "note": "scikit-learn normalises disparities over the full matrix and uses its own stopping rule; tie handling is the pooled (secondary-like) isotonic fit"}
for scope in ["KR", "JP", "ALL"]:
    b = json.load(open(f"{bundle_dir}/bundle_{scope}.json", encoding="utf-8"))["bundle"]
    a = b["analysis"]
    S = np.array(a["S"], dtype=float)
    N = a["N"]
    n = len(S)
    delta = 1 - S / N
    np.fill_diagonal(delta, 0)
    sel = a["primary"]["selected"]
    X_ours = np.array(a["primary"]["coordinates"])
    X0 = start(sel["seed"], n)
    r = {"ours": metrics(X_ours, S), "selected_start_seed": sel["seed"]}
    for eps in (1e-9, 1e-12):
        Xs, st, it = smacof(delta, metric=False, n_components=2, init=X0, n_init=1, max_iter=20000, eps=eps, return_n_iter=True, normalized_stress=True)
        raw_s, st_raw = None, None
        _, st_unnorm, _ = smacof(delta, metric=False, n_components=2, init=X0, n_init=1, max_iter=20000, eps=eps, return_n_iter=True, normalized_stress=False)
        r[f"sklearn_eps_{eps:g}"] = {"iterations": int(it), "sklearn_reported_normalized_stress": float(st), "sklearn_reported_raw_stress": float(st_unnorm), "metrics_by_this_analysis_on_sklearn_configuration": metrics(Xs, S), "procrustes_relative_difference_vs_ours": procrustes_rel(X_ours, Xs)}
    # sklearn from its own random starts (not ours): best of 64
    best = None
    for k in range(64):
        Xk, stk = smacof(delta, metric=False, n_components=2, n_init=1, max_iter=20000, eps=1e-9, random_state=k, normalized_stress=True)
        if best is None or stk < best[1]:
            best = (Xk, stk)
    r["sklearn_best_of_64_own_random_starts"] = {"normalized_stress": float(best[1]), "metrics_by_this_analysis": metrics(best[0], S)}
    res[scope] = r
json.dump(res, open(out, "w"), indent=1)
print(json.dumps(res, indent=1))
