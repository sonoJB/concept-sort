"""Scans every text file of an extracted package for personal identifiers taken from the raw database snapshot
(participant names, phone numbers, real session ids, the admin token). Values are NEVER printed — only counts and the
kind of identifier. Usage: python pii_scan.py <db> <package dir> [more package dirs...]
Exit code 0 only if nothing was found."""
import os
import re
import sqlite3
import sys

db = sys.argv[1]
dirs = sys.argv[2:]
c = sqlite3.connect("file:" + db.replace("\\", "/") + "?mode=ro", uri=True)
names = {r[0] for r in c.execute("select participantName from SortSession") if r[0] and r[0].strip()}
phones = {r[0] for r in c.execute("select phoneNumber from SortSession") if r[0] and r[0].strip()}
sessions = {r[0] for r in c.execute("select id from SortSession")}
tokens = {r[0] for r in c.execute("select adminToken from Project")}
digits_names = {n for n in names if re.fullmatch(r"\d+", n)}
digits_long = {n for n in digits_names if len(n) >= 4} | {x.strip() for x in phones if re.fullmatch(r"\s*\d{4,}\s*", x)}
text_names = {n for n in names if n not in digits_names and len(n) >= 2}
phone_digits = {re.sub(r"\D", "", p) for p in phones if len(re.sub(r"\D", "", p)) >= 7}
TEXT_EXT = (".csv", ".md", ".txt", ".json", ".html", ".tsx", ".ts", ".py", ".svg")
hits = {"name": 0, "digit_only_name_as_whole_csv_cell": 0, "phone": 0, "session_id": 0, "admin_token": 0, "generic_phone_pattern": 0}
scanned = 0
for base in dirs:
    for root, _, files in os.walk(base):
        for f in files:
            p = os.path.join(root, f)
            if not f.lower().endswith(TEXT_EXT):
                continue
            try:
                t = open(p, encoding="utf-8-sig").read()
            except Exception:
                continue
            scanned += 1
            for n in text_names:
                if n in t:
                    hits["name"] += 1
            if f.endswith(".csv") and digits_long and "02_원자료_가명" in p.replace("\\", "/"):
                cells = set()
                for line in t.splitlines():
                    cells.update(x.strip('"') for x in line.split(","))
                hits["digit_only_name_as_whole_csv_cell"] += sum(1 for n in digits_long if n in cells)
            for s in sessions:
                if s in t:
                    hits["session_id"] += 1
            for tk in tokens:
                if tk in t:
                    hits["admin_token"] += 1
            for ph in {x for x in phones if len(x.strip()) >= 7}:
                if ph in t:
                    hits["phone"] += 1
            if re.search(r"(?<![\d.])0\d{1,4}-\d{1,4}-\d{4}(?!\d)", t):
                hits["generic_phone_pattern"] += 1
            if re.search(r"[\w.+-]+@[\w-]+(\.[\w-]+)+", t):
                hits["email_pattern"] = hits.get("email_pattern", 0) + 1
print({"text_files_scanned": scanned, "hits": hits, "identifier_counts_checked": {"names": len(names), "phones": len(phones), "session_ids": len(sessions), "tokens": len(tokens)}})
sys.exit(0 if not any(hits.values()) else 1)
