"""Collects every number and list used by the similarity-sorting manuscript draft from SOURCES, never from memory:

  * the stored result bundles of three analysis runs (GET .../runs/<id>/bundle saved as JSON)
  * a read-only copy of the database (descriptive statistics of the analysed participants, aggregated only; no names,
    phone numbers or session ids are read into the output)
  * the application's own guide-template code values (the actual sorting limits shown to participants), passed in by the caller

The result is one JSON-serialisable dict `D` plus a claim registry: every number printed in the document goes through
`Claims.num(...)`, which records (key, printed text, source) so the finished Word file can be checked against the sources.
"""
import collections
import datetime
import json
import sqlite3
import statistics as st

import numpy as np

SCOPES = ["KR", "JP", "ALL"]
KST = datetime.timezone(datetime.timedelta(hours=9))


class Claims:
    def __init__(self):
        self.rows = []

    def num(self, key, value, fmt, source):
        text = fmt(value) if callable(fmt) else format(value, fmt)
        self.rows.append({"key": key, "printed": text, "value": value, "source": source})
        return text


def f_apa(x, d=3):
    """APA style for quantities bounded by 1: no leading zero."""
    s = f"{x:.{d}f}"
    return s[1:] if s.startswith("0.") else s


def kst(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, KST)


def load_bundle(path):
    return json.load(open(path, encoding="utf-8"))["bundle"]


def boundary_items(b, thr=0.1):
    """Items of the recommended solution with map silhouette < thr, and the nearest other cluster (mean map distance)."""
    a = b["analysis"]
    k = b["naming"]["proposal"]["recommendedK"]
    sol = next(s for s in a["solutions"] if s["k"] == k)
    X = np.array(a["primary"]["coordinates"])
    lab = np.array(sol["labels"])
    D = np.sqrt(((X[:, None] - X[None]) ** 2).sum(2))
    out = []
    for i, s in enumerate(sol["silhouetteMap"]["perPoint"]):
        if s < thr:
            others = {c: D[i, lab == c].mean() for c in range(1, k + 1) if c != lab[i]}
            out.append({"item": i + 1, "cluster": int(lab[i]), "silhouette": s, "nearest_other": int(min(others, key=others.get))})
    return out


def descriptives(db_path, bundles):
    con = sqlite3.connect("file:" + db_path.replace("\\", "/") + "?mode=ro", uri=True)
    rows = con.execute("select id, countryCode, gender, age, schoolLevel, grade, createdAt, consentAgreed from SortSession where dataRole='MAIN'").fetchall()
    pilot = collections.Counter(r[0] for r in con.execute("select countryCode from SortSession where dataRole<>'MAIN'"))
    labels = collections.defaultdict(lambda: [0, 0])
    for country, label in con.execute("select s.countryCode, g.label from SortGroup g join SortSession s on s.id=g.sortSessionId where s.dataRole='MAIN'"):
        labels[country][0] += 1
        labels[country][1] += 0 if label.strip() else 1
    project = con.execute("select slug, mainStudyStartsAt from Project").fetchone()
    out = {}
    for sc in SCOPES:
        r = [x for x in rows if sc == "ALL" or x[1] == sc]
        ages = [x[3] for x in r]
        lab = [0, 0]
        for c in ([sc] if sc != "ALL" else ["KR", "JP"]):
            lab[0] += labels[c][0]
            lab[1] += labels[c][1]
        out[sc] = {
            "n": len(r),
            "gender": dict(collections.Counter(x[2] for x in r)),
            "school_level": dict(collections.Counter(x[4] for x in r)),
            "school_grade": {f"{k[0]}|{k[1]}": v for k, v in collections.Counter((x[4], x[5]) for x in r).items()},
            "age": {"mean": st.mean(ages), "sd": st.stdev(ages), "min": min(ages), "max": max(ages)},
            "first_submission": kst(min(x[6] for x in r)).isoformat(),
            "last_submission": kst(max(x[6] for x in r)).isoformat(),
            "consent_recorded": sum(1 for x in r if x[7]),
            "pile_labels_total": lab[0],
            "pile_labels_empty": lab[1],
        }
    pilot_by = {k: v for k, v in collections.Counter(r[0] for r in con.execute("select countryCode from SortSession where dataRole<>'MAIN'")).items()}
    study_start = kst(project[1]).isoformat() if project[1] else None
    con.close()
    return out, pilot_by, study_start


def scope_block(b):
    a = b["analysis"]
    p = a["primary"]
    prop = b["naming"]["proposal"]
    k = prop["recommendedK"]
    sol = next(s for s in a["solutions"] if s["k"] == k)
    merges = a["ward"]["merges"]
    heights = {m["clustersAfter"]: m["height"] for m in merges}
    sig = [int(x) for x in prop["solution"]["signature"].split(",")]
    lower = next((s for s in a["solutions"] if s["k"] == k - 1), None)
    merged = []
    if lower:
        by_low = collections.defaultdict(set)
        for g_hi, g_lo in zip(sig, lower["labels"]):
            by_low[g_lo].add(g_hi)
        merged = [sorted(v) for v in by_low.values() if len(v) > 1]
    names_by_id = {c["cluster"]: c["nameKo"] for c in prop["solution"]["clusters"]}
    clusters = []
    for c in prop["solution"]["clusters"]:
        members = [i + 1 for i, g in enumerate(sig) if g == c["cluster"]]
        clusters.append({"cluster": c["cluster"], "name": c["nameKo"], "members": members})
    ksel = []
    for s in a["solutions"]:
        ksel.append({"k": s["k"], "min_size": s["minSize"], "small": s["smallClusters"], "sil_map": s["silhouetteMap"]["mean"], "sil_delta": s["silhouetteDelta"]["mean"], "between": s["betweenShare"], "height_to_k": heights.get(s["k"])})
    dims = []
    for d in a["dimensions"]:
        dims.append({"dimension": d["dimension"], "stress1": d["stress1"], "rsq": d["rsq"], "raw": d["rawStress"], "converged": d["numericallyConverged"], "conv_starts": d["convergedStarts"], "starts": d["startCount"], "main_reason": d["selected"]["main"]["reason"] if d["selected"] else None, "strict_reason": d["selected"]["strict"]["reason"] if d["selected"] else None})
    sh = a["splitHalf"]
    return {
        "run_id": b["meta"]["runId"],
        "algorithm": b["meta"]["algorithmVersion"],
        "commit": b["meta"]["engineSourceCommitSha"],
        "snapshot_at": b["meta"]["dataSnapshotAt"],
        "computed_at": b["meta"]["computedAt"],
        "N": b["meta"]["N"],
        "nKr": b["meta"]["nKr"],
        "nJp": b["meta"]["nJp"],
        "statements": b["meta"]["statementCount"],
        "fingerprints": b["meta"]["fingerprints"],
        "stress1": p["stress1"],
        "raw": p["rawStress"],
        "v1def": p["stress1V1Definition"],
        "rsq": p["rsq"],
        "starts": {"converged": p["convergedStarts"], "total": p["startCount"], "within": p["startsWithinRelTol1e6OfBest"]},
        "main": p["selected"]["main"],
        "strict": p["selected"]["strict"],
        "tie": a["tieSensitivity"],
        "dims": dims,
        "piles": a["participantSummary"]["piles"],
        "max_pile": a["participantSummary"]["maxPile"],
        "matrix": a["matrixChecks"],
        "settings": a["settings"],
        "rec_k": k,
        "review_status": prop["reviewStatus"],
        "clusters": clusters,
        "alternatives": [x["k"] for x in prop["alternatives"]],
        "k_table": ksel,
        "merged_at_k_minus_1": [[{"cluster": c, "name": names_by_id[c]} for c in grp] for grp in merged],
        "boundary": boundary_items(b),
        "cluster_sil": {c["cluster"]: c["meanSilhouette"] for c in sol["clusters"]},
        "split": {"design": sh["design"], "reps": sh["repetitions"], "seed": sh["seed"], "raw": sh["rawR"], "sb": sh["spearmanBrown"], "undefined": sh["undefinedCount"], "negative": sh["negativeRawCount"]},
        "statements_text": [(s["no"], s["textKo"]) for s in b["statements"]],
    }


def collect(bundle_paths, db_path):
    bundles = {sc: load_bundle(bundle_paths[sc]) for sc in SCOPES}
    D = {"scopes": {sc: scope_block(bundles[sc]) for sc in SCOPES}}
    D["desc"], D["pilot_excluded"], D["study_start"] = descriptives(db_path, bundles)
    return D, bundles
