#!/usr/bin/env python3
"""Independent check of the Word draft against its sources (it does NOT import the builder's data module):

  python -X utf8 verify_manuscript.py --docx FILE --bundles-dir DIR --db SNAPSHOT.db --out REPORT.md

Re-reads the stored result bundles and the database copy with its own code and checks that
  * every key figure of every table (N, Stress-1, raw stress, RSQ, convergence, per-dimension rows, k-comparison rows,
    split-half summary, descriptive statistics) appears in the document exactly as formatted from the source value,
  * every scope's cluster table lists each of the 47 statements exactly once and matches the stored cluster membership,
  * the 47 statement texts in the appendix equal the Statement table of the database,
  * the document contains only the three analysis run ids it names, and none of the phrases the instructions forbid
    (e.g. a verdict such as "매우 적합", "타당성 입증", SPSS as the analysis tool, "최적 차원", an RSQ .60 criterion applied).
Exit code 0 only if every check passes.
"""
import argparse
import collections
import json
import os
import re
import sqlite3
import sys

from docx import Document

SC = ["KR", "JP", "ALL"]


def doc_text(path):
    d = Document(path)
    parts = [p.text for p in d.paragraphs]
    tables = []
    for t in d.tables:
        rows = [[c.text for c in r.cells] for r in t.rows]
        tables.append(rows)
        for r in rows:
            parts.append(" | ".join(r))
    return "\n".join(parts), tables


def apa(x, d):
    s = f"{x:.{d}f}"
    return s[1:] if s.startswith("0.") else s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--docx", required=True)
    ap.add_argument("--bundles-dir", required=True)
    ap.add_argument("--db", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    text, tables = doc_text(a.docx)
    flat = re.sub(r"\s+", " ", text)
    B = {sc: json.load(open(os.path.join(a.bundles_dir, f"bundle_{sc}_production.json"), encoding="utf-8"))["bundle"] for sc in SC}
    results = []

    def check(name, ok, detail=""):
        results.append((name, bool(ok), detail))

    def has(s):
        return s in flat

    for sc in SC:
        b = B[sc]
        an = b["analysis"]
        p = an["primary"]
        sel = p["selected"]
        check(f"[{sc}] run id named in the document", has(b["meta"]["runId"][:12]))
        check(f"[{sc}] N", has(str(b["meta"]["N"])))
        for label, val in (("Stress-1", apa(p["stress1"], 4)), ("RSQ", apa(p["rsq"], 4)), ("raw stress", f"{p['rawStress']:.3f}"), ("v1 definition", apa(p["stress1V1Definition"], 4))):
            check(f"[{sc}] {label} {val} appears", has(val))
        check(f"[{sc}] main convergence row", has(f"{sel['main']['reason']}, {sel['main']['iterations']}회, {sel['main']['finalRelativeChange']:.2e}"))
        check(f"[{sc}] strict convergence row", has(f"{sel['strict']['reason']}, {sel['strict']['iterations']}회, {sel['strict']['finalRelativeChange']:.2e}"))
        tie = an["tieSensitivity"]
        check(f"[{sc}] tie sensitivity", has(f"{apa(tie['stress1'], 4)} / {apa(tie['rsq'], 4)}"))
        for d in an["dimensions"]:
            row = f"{apa(d['stress1'], 4)} | {apa(d['rsq'], 4)} | {d['rawStress']:.3f}"
            check(f"[{sc}] dimension {d['dimension']}: {row}", has(row))
        for s in an["solutions"]:
            row = f"{s['minSize']} | {s['smallClusters']} | {apa(s['silhouetteMap']['mean'], 3)} | {apa(s['silhouetteDelta']['mean'], 3)} | {apa(s['betweenShare'], 3)}"
            check(f"[{sc}] k={s['k']} comparison row", has(row))
        sh = an["splitHalf"]
        check(f"[{sc}] split-half raw", has(f"{sh['rawR']['mean']:.3f} | {sh['rawR']['median']:.3f} | {sh['rawR']['min']:.3f}–{sh['rawR']['max']:.3f}"))
        check(f"[{sc}] split-half SB", has(f"{sh['spearmanBrown']['mean']:.3f} | {sh['spearmanBrown']['median']:.3f} | {sh['spearmanBrown']['min']:.3f}–{sh['spearmanBrown']['max']:.3f}"))
        ps = an["participantSummary"]["piles"]
        check(f"[{sc}] piles M(SD)", has(f"{ps['mean']:.2f} ({ps['sd']:.2f})"))
        mc = an["matrixChecks"]
        check(f"[{sc}] matrix summary", has(str(mc["maxOffDiagonal"])) and has(str(mc["neverTogether"])) and has(str(mc["distinctLevels"])))
        # cluster table from stored membership
        prop = b["naming"]["proposal"]
        sig = [int(x) for x in prop["solution"]["signature"].split(",")]
        k = prop["recommendedK"]
        found = collections.Counter()
        ok_members = True
        for c in prop["solution"]["clusters"]:
            mem = [i + 1 for i, g in enumerate(sig) if g == c["cluster"]]
            listing = ", ".join(f"S{m:02d}" for m in mem)
            if listing not in flat:
                ok_members = False
            for m in mem:
                found[m] += 1
            if c["nameKo"] not in flat:
                ok_members = False
        check(f"[{sc}] recommended {k}-cluster table equals stored membership and names", ok_members)
        check(f"[{sc}] every statement 1..47 in exactly one cluster", sorted(found) == list(range(1, 48)) and all(v == 1 for v in found.values()))
    # descriptives
    con = sqlite3.connect("file:" + a.db.replace("\\", "/") + "?mode=ro", uri=True)
    rows = con.execute("select countryCode,gender,age,schoolLevel,grade from SortSession where dataRole='MAIN'").fetchall()
    import statistics as st

    for sc in SC:
        r = [x for x in rows if sc == "ALL" or x[0] == sc]
        ages = [x[2] for x in r]
        check(f"[{sc}] age M(SD) {st.mean(ages):.2f} ({st.stdev(ages):.2f})", has(f"{st.mean(ages):.2f} ({st.stdev(ages):.2f})"))
        check(f"[{sc}] gender counts", has(f"{sum(1 for x in r if x[1] == '여자')} / {sum(1 for x in r if x[1] == '남자')}"))
    # statements appendix equals database
    stm = con.execute('select text from Statement order by "order"').fetchall()
    appendix_rows = [r for t in tables for r in t if len(r) == 2 and re.fullmatch(r"S\d\d", r[0] or "")]
    check("appendix has 47 statements", len(appendix_rows) == 47, str(len(appendix_rows)))
    check("appendix texts equal the Statement table (database copy)", all(appendix_rows[i][1] == stm[i][0] for i in range(min(47, len(appendix_rows)))))
    # run ids and forbidden phrases
    ids = {B[sc]["meta"]["runId"][:12] for sc in SC}
    named = set(re.findall(r"cmv[a-z0-9]{9}", flat))
    check("only the three analysed runs are named", named <= ids, str(named - ids))
    forbidden = ["매우 적합", "타당성이 입증", "타당성 입증", "최적 차원으로", "엘보가 확인", "SPSS로 분석", "SPSS 26", "R²의 변화량이 가장 큰", "RSQ가 .6 이상", "적절한 수준(.205"]
    for ph in forbidden:
        check(f"forbidden phrase absent: {ph}", ph not in flat)
    must = ["연구자 확정 전", "탐색적 검토 규칙", "원문", "[확인 필요", "같은 번호가 같은 개념을 뜻하지 않"]
    for ph in must:
        check(f"required statement present: {ph}", ph in flat)
    ok = all(r[1] for r in results)
    with open(a.out, "w", encoding="utf-8") as fh:
        fh.write(f"# 논문 초안 수치·문항·인용 대조 결과\n\n파일: {os.path.basename(a.docx)}\n\n{sum(1 for r in results if r[1])}/{len(results)}개 검사 통과\n\n")
        for name, good, detail in results:
            fh.write(f"- {'PASS' if good else 'FAIL'} {name}{(' — ' + detail) if detail else ''}\n")
    print(f"{sum(1 for r in results if r[1])}/{len(results)} checks passed")
    for name, good, detail in results:
        if not good:
            print("FAIL", name, detail)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
