"""Independent verification of the similarity / dissimilarity matrices (does NOT call any application code).

Everything is recomputed from the ORIGINAL pile placements in the SQLite database (SortSession / SortGroup /
SortGroupItem / Statement) with plain SQL and plain Python, and compared with
  (a) the stored result bundle of a run (GET .../runs/<id>/bundle saved as JSON): S, the stored MDS input
      (pairDiagnostics.delta), participant summary;
  (b) the matrix CSV files of an extracted analysis package (04_행렬/*.csv) and its statement table.

Definitions checked (Trochim, 1989, Step 3 "Structuring of Statements"; the personal matrix is a BINARY
SIMILARITY matrix: same pile = 1, different pile = 0, diagonal 1):
  B_p   personal binary similarity matrix (diagonal 1)
  S     = sum_p B_p                   (diagonal N)
  P     = S / N                       (diagonal 1)
  D     = N - S                       (diagonal 0)
  delta = 1 - S / N                   (diagonal 0)   <- the MDS input of this application

Usage: python -X utf8 verify_matrices_independent.py <db> <scope KR|JP|ALL> <bundle.json> <package dir> <out.json>
Only counts and booleans are written; no participant value is printed.
"""
import csv
import json
import sqlite3
import sys

db, scope, bundle_path, pkg_dir, out_path = sys.argv[1:6]
countries = {"KR": ["KR"], "JP": ["JP"], "ALL": ["KR", "JP"]}[scope]
res = {"scope": scope, "checks": {}}


def check(name, ok, detail=None):
    res["checks"][name] = {"ok": bool(ok), **({"detail": detail} if detail is not None else {})}
    print(("PASS " if ok else "FAIL ") + name + (f"  {detail}" if detail is not None else ""))


con = sqlite3.connect("file:" + db.replace("\\", "/") + "?mode=ro", uri=True)
statements = [r[0] for r in con.execute("select id from Statement order by \"order\"")]
n = len(statements)
idx = {sid: i for i, sid in enumerate(statements)}
check("statement count is 47", n == 47, n)

# ---- eligible participants: MAIN, scope countries, every statement placed exactly once
rows = con.execute(
    f"select s.id, s.countryCode from SortSession s where s.dataRole='MAIN' and s.countryCode in ({','.join('?' * len(countries))})", countries
).fetchall()
placement = {}  # session id -> {statement index -> group id}
bad = []
for sess, cc in rows:
    items = con.execute(
        "select i.statementId, g.id from SortGroupItem i join SortGroup g on g.id=i.groupId where g.sortSessionId=?", (sess,)
    ).fetchall()
    stm = [idx[a] for a, _ in items if a in idx]
    if len(items) != n or len(set(stm)) != n:
        bad.append(sess)
        continue
    placement[sess] = (cc, {idx[a]: g for a, g in items})
N = len(placement)
by_country = {c: sum(1 for v in placement.values() if v[0] == c) for c in countries}
res["N"] = N
res["N_by_country"] = by_country
res["excluded_incomplete_or_duplicate"] = len(bad)
print("participants:", N, by_country, "incomplete/duplicate:", len(bad))

# ---- S by explicit double loop over personal binary matrices (pure Python)
def S_for(keys):
    S = [[0] * n for _ in range(n)]
    for k in keys:
        pl = placement[k][1]
        for i in range(n):
            for j in range(n):
                if pl[i] == pl[j]:
                    S[i][j] += 1
    return S


S = S_for(placement)
# ---- S again by a SET-BASED SQL self join (different method): number of sessions in which i and j share a group
q = f"""
select a.statementId, b.statementId, count(*) from SortGroupItem a
 join SortGroupItem b on a.groupId=b.groupId
 join SortGroup g on g.id=a.groupId
 join SortSession s on s.id=g.sortSessionId
where s.dataRole='MAIN' and s.countryCode in ({','.join('?' * len(countries))}) and s.id in ({','.join('?' * len(placement))})
group by a.statementId, b.statementId
"""
S_sql = [[0] * n for _ in range(n)]
for a, b, c in con.execute(q, countries + list(placement)):
    S_sql[idx[a]][idx[b]] = c
check("S from personal binary matrices == S from SQL self-join (all 47x47 cells)", S == S_sql)
check("diagonal of S equals N", all(S[i][i] == N for i in range(n)), N)
check("S symmetric", all(S[i][j] == S[j][i] for i in range(n) for j in range(n)))
check("off-diagonal S within 0..N", all(0 <= S[i][j] <= N for i in range(n) for j in range(n) if i != j))

# ---- ALL = KR + JP cell by cell
if scope == "ALL":
    SK = S_for([k for k, v in placement.items() if v[0] == "KR"])
    SJ = S_for([k for k, v in placement.items() if v[0] == "JP"])
    check("S_ALL == S_KR + S_JP in every cell", all(S[i][j] == SK[i][j] + SJ[i][j] for i in range(n) for j in range(n)))
    NK, NJ = by_country["KR"], by_country["JP"]
    wmax = max(abs(S[i][j] / N - (NK * SK[i][j] / NK + NJ * SJ[i][j] / NJ) / N) for i in range(n) for j in range(n))
    simple = max(abs(S[i][j] / N - (SK[i][j] / NK + SJ[i][j] / NJ) / 2) for i in range(n) for j in range(n))
    check("P_ALL equals the participant-count-weighted mean of P_KR and P_JP (max abs diff)", wmax < 1e-12, wmax)
    check("P_ALL differs from the simple mean of P_KR and P_JP (max abs diff, expected > 0 because N differs)", simple > 1e-3, simple)

# ---- stored bundle
b = json.load(open(bundle_path, encoding="utf-8"))["bundle"]
a = b["analysis"]
check("bundle N equals independent N", b["meta"]["N"] == N, (b["meta"]["N"], N))
check("bundle S equals independent S (all cells)", a["S"] == S)
pd = a["pairDiagnostics"]
check("stored pair table has 1081 pairs", len(pd) == n * (n - 1) // 2, len(pd))
check("stored pair S == independent S", all(p["S"] == S[p["i"]][p["j"]] for p in pd))
check("stored pair P == S/N", all(abs(p["P"] - S[p["i"]][p["j"]] / N) < 1e-12 for p in pd))
check("stored pair D == N - S", all(p["D"] == N - S[p["i"]][p["j"]] for p in pd))
check("stored MDS input delta == 1 - S/N for all 1081 pairs", all(abs(p["delta"] - (1 - S[p["i"]][p["j"]] / N)) < 1e-12 for p in pd))

# ---- package files
def read_matrix(path):
    rows_ = list(csv.reader(open(path, encoding="utf-8-sig")))
    return [[float(x) for x in r[1:]] for r in rows_[1:]], rows_[0][1:], [r[0] for r in rows_[1:]]


import glob
import os

mats = {k: glob.glob(os.path.join(pkg_dir, "04_행렬", pat))[0] for k, pat in {"S": "S_*.csv", "P": "P_*.csv", "D": "D_*.csv", "delta": "delta_*.csv", "legacy0": "기존표시형식_빈도행렬_*.csv", "legacyN": "기존표시형식_분석용_*.csv"}.items()}
M = {}
for k, p in mats.items():
    M[k], cols, rowsn = read_matrix(p)
    check(f"{k}: 47x47 and row/column labels identical and in statement order", len(M[k]) == n and all(len(r) == n for r in M[k]) and cols == rowsn)
stm_csv = list(csv.reader(open(glob.glob(os.path.join(pkg_dir, "03_진술문", "*.csv"))[0], encoding="utf-8-sig")))[1:]
check("package statement table order == database statement order", [r[2] for r in stm_csv] == statements)
check("package S == independent S", all(M["S"][i][j] == S[i][j] for i in range(n) for j in range(n)))
check("package P == S/N (diagonal 1)", all(abs(M["P"][i][j] - S[i][j] / N) < 1e-9 for i in range(n) for j in range(n)) and all(M["P"][i][i] == 1 for i in range(n)))
check("package D == N - S (diagonal 0)", all(M["D"][i][j] == N - S[i][j] for i in range(n) for j in range(n)) and all(M["D"][i][i] == 0 for i in range(n)))
check("package delta == 1 - S/N off-diagonal, diagonal 0", all(abs(M["delta"][i][j] - (1 - S[i][j] / N)) < 1e-9 for i in range(n) for j in range(n) if i != j) and all(M["delta"][i][i] == 0 for i in range(n)))
check("legacy 'frequency matrix, diagonal 0' == S with diagonal set to 0 (it is a SIMILARITY count, not a dissimilarity)", all(M["legacy0"][i][j] == (S[i][j] if i != j else 0) for i in range(n) for j in range(n)))
check("legacy 'analysis similarity frequency, diagonal N' == S", all(M["legacyN"][i][j] == S[i][j] for i in range(n) for j in range(n)))
offdiff = sum(1 for i in range(n) for j in range(n) if i != j and M["legacy0"][i][j] != M["D"][i][j])
check("legacy diagonal-0 similarity matrix differs from D in off-diagonal cells (so it must not be called a dissimilarity matrix)", offdiff > 0, offdiff)
res["ok"] = all(c["ok"] for c in res["checks"].values())
json.dump(res, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("ALL CHECKS PASSED" if res["ok"] else "SOME CHECKS FAILED")
sys.exit(0 if res["ok"] else 1)
