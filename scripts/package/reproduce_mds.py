#!/usr/bin/env python3
"""Independent reproduction of the analysis in this package (numpy only; no scipy / scikit-learn).

What it does, using ONLY the pseudonymous response table in 02_원자료_가명:
  1. rebuilds S (diagonal N), P, D, delta = 1 - S/N and compares S with 04_행렬/S_*.csv
  2. runs the 2D nonmetric SMACOF (secondary ties, sum d_hat^2 = n(n-1)/2, 64 reproducible starts, eps 1e-9, then the
     selected solution continued to 1e-12) with the same pseudo-random starts as the application (mulberry32 /
     deriveSeed replicas), selects the lowest raw stress among CONVERGED starts, recomputes raw stress, Stress-1, RSQ
  3. compares coordinates, Stress-1 and termination with 05_MDS files
  4. Ward clustering (direct sum-of-squares formulation), cluster memberships for k = 2..10, silhouettes
     and compares them with 07_군집/군집소속_k별.csv
Usage:  python reproduce_mds.py <package root> [--starts 64] [--skip-mds]
Exit code 0 only if every comparison is within tolerance.
"""
import csv
import itertools
import json
import os
import sys

import numpy as np

root = sys.argv[1] if len(sys.argv) > 1 else "."
n_starts = int(sys.argv[sys.argv.index("--starts") + 1]) if "--starts" in sys.argv else 64
skip_mds = "--skip-mds" in sys.argv


def find(*parts):
    base = os.path.join(root, *parts)
    return base


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.reader(f))


settings = json.load(open(find("10_재현", "settings.json"), encoding="utf-8"))
mds = settings["analysis"]["mds"]

# ------------------------------------------------------------------ 1. S from the response table
rows = read_csv(find("02_원자료_가명", "참여자별_분류응답표.csv"))
hdr = rows[0]
ci = {h: i for i, h in enumerate(hdr)}
by = {}
for r in rows[1:]:
    by.setdefault(r[ci["가명ID"]], {})[int(r[ci["문항번호"]]) - 1] = int(r[ci["묶음번호(참여자 내)"]])
pids = list(by)
n = max(max(v) for v in by.values()) + 1
assign = np.array([[by[p][i] for i in range(n)] for p in pids])
N = len(pids)
S = np.zeros((n, n))
for a in assign:
    S += a[:, None] == a[None, :]
delta = 1 - S / N
np.fill_diagonal(delta, 0)
ok = True


def check(name, cond, detail=""):
    global ok
    ok &= bool(cond)
    print(("PASS " if cond else "FAIL ") + name + (f"  {detail}" if detail else ""))


S_file = np.array([[float(x) for x in r[1:]] for r in read_csv(find("04_행렬", "S_집단유사성빈도_대각선N.csv"))[1:]])
check("S rebuilt from responses equals 04_행렬/S", (S == S_file).all(), f"N={N}, statements={n}")
check("diagonal of S equals N", (np.diag(S) == N).all())

# ------------------------------------------------------------------ SMACOF (independent implementation)
iu = np.triu_indices(n, 1)
levels = sorted(set(S[iu].tolist()), reverse=True)  # ascending delta == descending S
grp = [np.where(S[iu] == lv)[0] for lv in levels]
q = n * (n - 1) / 2


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
    out = []
    for v, _, c in blocks:
        out += [v] * c
    return np.array(out)


def state(X):
    d = np.sqrt(((X[iu[0]] - X[iu[1]]) ** 2).sum(1))
    gm = np.array([d[g].mean() for g in grp])
    gw = np.array([len(g) for g in grp], float)
    fit = pava(gm, gw)
    dh = np.empty_like(d)
    for g, v in zip(grp, fit):
        dh[g] = v
    star = dh.copy()
    dh = dh * np.sqrt(q / (dh**2).sum())
    return d, dh, star, ((dh - d) ** 2).sum()


def guttman(X, d, dh):
    B = np.zeros((n, n))
    ratio = np.where(d > 0, dh / np.where(d > 0, d, 1), 0.0)
    B[iu] = -ratio
    B = B + B.T
    B[np.diag_indices(n)] = -B.sum(1)
    Xn = B @ X / n
    return Xn - Xn.mean(0)


def run(X0, eps, max_iter, trace=None, cont=False):
    X = X0 - X0.mean(0)
    prev = trace[-1] if trace else None
    trace = list(trace) if trace else []
    it = 0
    while True:
        d, dh, star, raw = state(X)
        if cont and it == 0:
            prev = raw
        else:
            trace.append(raw)
            if prev is not None:
                rel = (prev - raw) / prev
                if rel < -1e-9:
                    return X, "OBJECTIVE_INCREASED", len(trace), trace, rel
                if rel <= eps:
                    return X, "CONVERGED", len(trace), trace, rel
            prev = raw
        it += 1
        if it > max_iter:
            return X, "MAX_ITER", len(trace), trace, None
        X = guttman(X, d, dh)


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


def random_start(seed, dim=2):
    rng = mulberry32(seed)
    X = np.array([[-1 + rng() * 2 for _ in range(dim)] for _ in range(n)])
    return X - X.mean(0)


coords_file = np.array([[float(x) for x in r[1:3]] for r in read_csv(find("05_MDS", "좌표_2D.csv"))[1:]])
if not skip_mds:
    cands = []
    for k in range(n_starts):
        seed = derive_seed(mds["randomSeed"], k)
        X, reason, iters, tr, rel = run(random_start(seed), mds["eps"], mds["maxIter"])
        cands.append((tr[-1], reason, iters, tr, X, k, seed))
    conv = [c for c in cands if c[1] == "CONVERGED"]
    best = min(conv, key=lambda c: c[0])
    X2, r2, it2, tr2, rel2 = run(best[4], mds["strictEps"], mds["strictMaxIter"], [best[0]], cont=True)
    d, dh, star, raw = state(X2)
    s1 = float(np.sqrt(((star - d) ** 2).sum() / (d**2).sum()))
    rsq = float(np.corrcoef(dh, d)[0, 1] ** 2)
    print(f"selected start #{best[5]} (seed {best[6]}), main {best[1]} {best[2]} it, strict {r2} {it2 - 1} extra it, raw={raw:.8f} Stress-1={s1:.8f} RSQ={rsq:.6f}")
    check("converged starts", len(conv) == n_starts, f"{len(conv)}/{n_starts}")
    check("max |coordinate difference| vs 05_MDS/좌표_2D.csv < 1e-6", np.abs(X2 - coords_file).max() < 1e-6, f"{np.abs(X2 - coords_file).max():.2e}")
    summ = {r[0]: r[1] for r in read_csv(find("01_요약", "분석요약.csv"))[1:]}
    check("Stress-1 equals the reported value (1e-9)", abs(s1 - float(summ["Stress-1 (Kruskal)"])) < 1e-9)
    check("Stress-1 equals sqrt(raw/q) at the solution (JSS eq. 4)", abs(s1 - np.sqrt(raw / q)) < 1e-6)
    X_for_ward = X2
else:
    X_for_ward = coords_file


# ------------------------------------------------------------------ Ward + silhouette
def ward(X):
    cl = {i: [i] for i in range(len(X))}
    nxt = len(X)
    out = []
    while len(cl) > 1:
        best = None
        for a, b in itertools.combinations(sorted(cl), 2):
            na, nb = len(cl[a]), len(cl[b])
            inc = na * nb / (na + nb) * ((X[cl[a]].mean(0) - X[cl[b]].mean(0)) ** 2).sum()
            if best is None or inc < best[0] - 1e-15:
                best = (inc, a, b)
        inc, a, b = best
        cl[nxt] = cl.pop(a) + cl.pop(b)
        out.append((min(a, b), max(a, b), float(np.sqrt(2 * inc))))
        nxt += 1
    return out


def cut(link, k):
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


def silhouette(Dm, lab):
    lab = np.array(lab)
    kk = lab.max()
    s = np.zeros(n)
    for i in range(n):
        own = np.where(lab == lab[i])[0]
        if len(own) == 1:
            continue
        a = Dm[i, own[own != i]].mean()
        b = min(Dm[i, np.where(lab == c)[0]].mean() for c in range(1, kk + 1) if c != lab[i])
        s[i] = (b - a) / max(a, b)
    return s


link = ward(X_for_ward)
mem = read_csv(find("07_군집", "군집소속_k별.csv"))
ks = [int(h.split("=")[1]) for h in mem[0][1:]]
Dm = np.sqrt(((X_for_ward[:, None] - X_for_ward[None]) ** 2).sum(2))
allok = True
sil_rows = {r[0]: r for r in read_csv(find("07_군집", "군집후보비교.csv"))[1:]}
for j, k in enumerate(ks):
    lab = cut(link, k)
    same = lab == [int(r[1 + j]) for r in mem[1:]]
    allok &= same
    sil = silhouette(Dm, lab).mean()
    allok &= abs(sil - float(sil_rows[str(k)][3])) < 1e-6
check("Ward memberships and map silhouettes for every k match 07_군집", allok)
print("ALL CHECKS PASSED" if ok else "SOME CHECKS FAILED")
sys.exit(0 if ok else 1)
