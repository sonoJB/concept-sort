"""Independent checks (numpy only) of Ward, silhouette, convex hull, split-half reliability, Spearman, Procrustes.
Usage: python -X utf8 -I crossval_clusters.py <dir with analysis_*.json and raw.json> <out.json>"""
import json, sys, itertools
import numpy as np

d, out = sys.argv[1], sys.argv[2]
raw = json.load(open(f"{d}/raw.json", encoding="utf-8"))
parts = raw["participants"]
n = len(raw["statements"])


def ward_bruteforce(X):
    # merge the pair with the smallest increase of the within-cluster sum of squares
    #   n_a n_b / (n_a + n_b) * |c_a - c_b|^2 ; reported height = sqrt(2 * increase)
    cl = {i: [i] for i in range(len(X))}
    nxt = len(X)
    rows = []
    while len(cl) > 1:
        best = None
        for a, b in itertools.combinations(sorted(cl), 2):
            ca, cb = X[cl[a]].mean(0), X[cl[b]].mean(0)
            na, nb = len(cl[a]), len(cl[b])
            inc = na * nb / (na + nb) * ((ca - cb) ** 2).sum()
            if best is None or inc < best[0] - 1e-15:
                best = (inc, a, b)
        inc, a, b = best
        cl[nxt] = cl.pop(a) + cl.pop(b)
        rows.append((min(a, b), max(a, b), float(np.sqrt(2 * inc)), len(cl[nxt])))
        nxt += 1
    return rows


def cut(rows, n_, k):
    parent = {}
    for idx, (l, r, h, s) in enumerate(rows[: n_ - k]):
        parent[l] = n_ + idx
        parent[r] = n_ + idx

    def find(x):
        while x in parent:
            x = parent[x]
        return x

    roots = {}
    lab = []
    for i in range(n_):
        r = find(i)
        roots.setdefault(r, len(roots))
        lab.append(roots[r])
    order = []
    for l in lab:
        if l not in order:
            order.append(l)
    return [order.index(l) + 1 for l in lab]


def silhouette(D, lab):
    lab = np.array(lab)
    k = lab.max()
    s = np.zeros(len(lab))
    for i in range(len(lab)):
        own = np.where(lab == lab[i])[0]
        if len(own) == 1:
            s[i] = 0
            continue
        a = D[i, own[own != i]].mean()
        b = min(D[i, np.where(lab == c)[0]].mean() for c in range(1, k + 1) if c != lab[i])
        s[i] = (b - a) / max(a, b)
    return s


def hull_jarvis(P, members):
    pts = [tuple(P[i]) for i in members]
    start = min(pts)
    hull = []
    cur = start
    while True:
        hull.append(cur)
        cand = pts[0] if pts[0] != cur else pts[1]
        for p in pts:
            if p == cur:
                continue
            c = (cand[0] - cur[0]) * (p[1] - cur[1]) - (cand[1] - cur[1]) * (p[0] - cur[0])
            if c < 0 or (c == 0 and (p[0] - cur[0]) ** 2 + (p[1] - cur[1]) ** 2 > (cand[0] - cur[0]) ** 2 + (cand[1] - cur[1]) ** 2):
                cand = p
        cur = cand
        if cur == start:
            break
    return hull


M32 = 0xFFFFFFFF


def imul(a, b):
    return (a * b) & M32


def derive_seed(base, index):
    h = ((base & M32) ^ imul(index + 1, 0x9E3779B9)) & M32
    h = imul(h ^ (h >> 16), 0x85EBCA6B) & M32
    h = imul(h ^ (h >> 13), 0xC2B2AE35) & M32
    return (h ^ (h >> 16)) & M32


def mulberry32(seed):
    s = [seed & M32]

    def rng():
        s[0] = (s[0] + 0x6D2B79F5) & M32
        t = s[0]
        t = imul(t ^ (t >> 15), t | 1)
        t = (t ^ ((t + imul(t ^ (t >> 7), t | 61)) & M32)) & M32
        return ((t ^ (t >> 14)) & M32) / 4294967296

    return rng


def shuffle(a, rng):
    r = list(a)
    for i in range(len(r) - 1, 0, -1):
        j = int(rng() * (i + 1))
        r[i], r[j] = r[j], r[i]
    return r


iu = np.triu_indices(n, 1)


def pairvec(assign):
    a = np.array(assign)
    return (a[:, None] == a[None, :])[iu].astype(float)


def rank_avg(v):
    v = np.asarray(v)
    o = np.argsort(v, kind="mergesort")
    r_ = np.empty(len(v))
    vs = v[o]
    i = 0
    while i < len(v):
        j = i
        while j + 1 < len(v) and vs[j + 1] == vs[i]:
            j += 1
        r_[o[i : j + 1]] = (i + j) / 2 + 1
        i = j + 1
    return r_


res = {}
for sc in ["KR", "JP", "ALL"]:
    a = json.load(open(f"{d}/analysis_{sc}.json", encoding="utf-8"))
    r = {}
    X = np.array(a["primary"]["coordinates"])
    rows = ward_bruteforce(X)
    ts = a["ward"]["linkage"]
    r["ward_max_abs_height_diff"] = max(abs(x[2] - t["mergeDistance"]) for x, t in zip(rows, ts))
    r["ward_merge_pairs_equal"] = all((x[0], x[1]) == (t["leftNode"], t["rightNode"]) for x, t in zip(rows, ts))
    D = np.sqrt(((X[:, None] - X[None]) ** 2).sum(2))
    S = np.array(a["S"])
    N = a["N"]
    delta = 1 - S / N
    np.fill_diagonal(delta, 0)
    mem_eq, sil_diff, sild_diff, hull_eq, wss_diff = True, 0.0, 0.0, True, 0.0
    for s in a["solutions"]:
        lab = cut(rows, n, s["k"])
        mem_eq &= lab == s["labels"]
        sil = silhouette(D, lab)
        sil_diff = max(sil_diff, abs(sil.mean() - s["silhouetteMap"]["mean"]), float(np.abs(sil - np.array(s["silhouetteMap"]["perPoint"])).max()))
        sd = silhouette(delta, lab)
        sild_diff = max(sild_diff, abs(sd.mean() - s["silhouetteDelta"]["mean"]))
        wss = 0.0
        for c in s["clusters"]:
            mem = c["members"]
            wss += ((X[mem] - X[mem].mean(0)) ** 2).sum()
            g = c["geometry"]
            if g["kind"] == "polygon":
                hv = {tuple(p) for p in g["hull"]}
                hw = set(hull_jarvis(X, mem))
                hull_eq &= hv == hw
        wss_diff = max(wss_diff, abs(wss - s["withinSS"]))
    r.update(
        partitions_equal_all_k=bool(mem_eq),
        silhouette_map_max_abs_diff=sil_diff,
        silhouette_delta_max_abs_diff=sild_diff,
        hull_vertices_equal=bool(hull_eq),
        withinSS_max_abs_diff=wss_diff,
    )
    inscope = parts if sc == "ALL" else [p for p in parts if p["country"] == sc]
    vec = {p["pid"]: pairvec(p["assignment"]) for p in inscope}
    groups = [("KR", [p for p in inscope if p["country"] == "KR"]), ("JP", [p for p in inscope if p["country"] == "JP"])] if sc == "ALL" else [(sc, inscope)]
    sh = a["splitHalf"]
    mx = 0.0
    mxs = 0.0
    for rep in range(sh["repetitions"]):
        rng = mulberry32(derive_seed(sh["seed"], rep))
        A = np.zeros(len(iu[0]))
        B = np.zeros(len(iu[0]))
        for name, people in groups:
            order = shuffle(people, rng)
            h = len(order) // 2
            for idx, p in enumerate(order):
                if idx < h:
                    A += vec[p["pid"]]
                else:
                    B += vec[p["pid"]]
        rr = np.corrcoef(A, B)[0, 1]
        mx = max(mx, abs(rr - sh["rawValues"][rep]))
        mxs = max(mxs, abs(2 * rr / (1 + rr) - sh["spearmanBrownValues"][rep]))
    r["split_half_max_abs_diff_raw"] = mx
    r["split_half_max_abs_diff_SB"] = mxs
    Sm = np.zeros((n, n))
    for p in inscope:
        v = np.array(p["assignment"])
        Sm += v[:, None] == v[None, :]
    r["S_equal_recount_from_raw_participants"] = bool((Sm == S).all())
    res[sc] = r

kr = json.load(open(f"{d}/analysis_KR.json", encoding="utf-8"))
jp = json.load(open(f"{d}/analysis_JP.json", encoding="utf-8"))
al = json.load(open(f"{d}/analysis_ALL.json", encoding="utf-8"))
pk = np.array(kr["S"])[iu] / kr["N"]
pj = np.array(jp["S"])[iu] / jp["N"]
res["comparison"] = {
    "pearson": float(np.corrcoef(pk, pj)[0, 1]),
    "spearman": float(np.corrcoef(rank_avg(pk), rank_avg(pj))[0, 1]),
    "all_equals_KR_plus_JP": bool((np.array(al["S"]) == np.array(kr["S"]) + np.array(jp["S"])).all()),
}
A = np.array(kr["primary"]["coordinates"])
B = np.array(jp["primary"]["coordinates"])
A = A - A.mean(0)
B = B - B.mean(0)
U, s, Vt = np.linalg.svd(B.T @ A)
R = U @ Vt
res["procrustes"] = {
    "orthogonal_rel_resid_unscaled": float(((A - B @ R) ** 2).sum() / (A**2).sum()),
    "det_R": float(np.linalg.det(R)),
    "disparity_unit_norm": float(1 - (s.sum() / (np.linalg.norm(A) * np.linalg.norm(B))) ** 2),
}
json.dump(res, open(out, "w"), indent=1)
print(json.dumps(res, indent=1))
