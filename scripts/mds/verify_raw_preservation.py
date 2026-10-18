"""Row- and column-level comparison of the RAW-DATA tables between two SQLite snapshots (before / after a change).
Values are never printed: only table, row counts and the NAMES of columns that differ. Derived analysis tables are
listed separately with their counts and are expected to change.
Usage: python verify_raw_preservation.py <before.db> <after.db> [out.json]"""
import json
import sqlite3
import sys

RAW = ["Project", "Statement", "SortSession", "SortGroup", "SortGroupItem"]
DERIVED = ["AnalysisRun", "AnalysisRunDimension", "AnalysisInterpretation", "AnalysisClusterLabel", "AnalysisExecutionLock", "AnalysisPackage"]


def ro(path):
    return sqlite3.connect("file:" + path.replace("\\", "/") + "?mode=ro", uri=True)


def table_exists(c, t):
    return c.execute("select 1 from sqlite_master where type='table' and name=?", (t,)).fetchone() is not None


def rows(c, t):
    cur = c.execute(f'select * from "{t}"')
    cols = [d[0] for d in cur.description]
    return cols, {r[cols.index("id")]: r for r in cur.fetchall()}


def main():
    b, a = ro(sys.argv[1]), ro(sys.argv[2])
    report = {"raw_tables": {}, "derived_tables": {}, "raw_identical": True}
    for t in RAW:
        cb, rb = rows(b, t)
        ca, ra = rows(a, t)
        info = {"columns_before": cb, "columns_after": ca, "columns_identical": cb == ca, "rows_before": len(rb), "rows_after": len(ra), "added": sorted(set(ra) - set(rb)).__len__(), "removed": sorted(set(rb) - set(ra)).__len__(), "modified_rows": 0, "modified_columns": []}
        mod_cols = set()
        for k in set(rb) & set(ra):
            if rb[k] != ra[k]:
                info["modified_rows"] += 1
                for i, col in enumerate(cb):
                    if col in ca and rb[k][i] != ra[k][ca.index(col)]:
                        mod_cols.add(col)
        info["modified_columns"] = sorted(mod_cols)
        info["identical"] = info["columns_identical"] and info["added"] == 0 and info["removed"] == 0 and info["modified_rows"] == 0
        report["raw_tables"][t] = info
        report["raw_identical"] &= info["identical"]
    for t in DERIVED:
        report["derived_tables"][t] = {"before": b.execute(f'select count(*) from "{t}"').fetchone()[0] if table_exists(b, t) else None, "after": a.execute(f'select count(*) from "{t}"').fetchone()[0] if table_exists(a, t) else None}
    text = json.dumps(report, ensure_ascii=False, indent=1)
    if len(sys.argv) > 3:
        open(sys.argv[3], "w", encoding="utf-8").write(text)
    print(text)
    sys.exit(0 if report["raw_identical"] else 1)


main()
