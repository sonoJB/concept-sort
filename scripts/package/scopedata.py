"""Everything the package writers need for ONE scope, derived only from the stored bundle + the pseudonymous raw
export (participants of that scope). No new analysis is performed here except descriptive summaries."""
import re

import numpy as np

from common import canonical_hash, derive, sid


class ScopeData:
    def __init__(self, scope, bundle, raw):
        self.scope = scope
        self.b = bundle
        self.a = bundle["analysis"]
        self.meta = bundle["meta"]
        self.statements = bundle["statements"]
        self.n = len(self.statements)
        self.N = self.a["N"]
        self.S = np.array(self.a["S"], dtype=float)
        self.P, self.D, self.delta = derive(self.S, self.N)
        self.coords = np.array(self.a["primary"]["coordinates"])
        parts = raw["participants"] if scope == "ALL" else [p for p in raw["participants"] if p["country"] == scope]
        self.participants = parts
        self.extras = raw["extras"]
        self.naming = bundle["naming"]
        self.proposal = self.naming["proposal"] if self.naming["status"] == "ATTACHED" else None
        self.rec_k = self.proposal["recommendedK"] if self.proposal else None
        self.sol = next((s for s in self.a["solutions"] if s["k"] == self.rec_k), None) if self.rec_k else None
        self.names = {c["cluster"]: c for c in (self.proposal["solution"]["clusters"] if self.proposal else [])}
        self.map_dist = np.sqrt(((self.coords[:, None] - self.coords[None]) ** 2).sum(2))

    # ---- verification against raw participants
    def verify_raw(self):
        n = self.n
        S = np.zeros((n, n))
        for p in self.participants:
            v = np.array(p["assignment"])
            S += v[:, None] == v[None, :]
        ok_S = bool((S == self.S).all())
        ph = canonical_hash(self.participants)
        return {"S_equals_recount_from_participant_records": ok_S, "participants_hash_recomputed": ph, "participants_hash_in_bundle": self.meta["fingerprints"]["participantsHash"], "participants_hash_match": ph == self.meta["fingerprints"]["participantsHash"], "participants": len(self.participants)}

    # ---- participant descriptive summaries
    def participant_rows(self):
        rows = []
        for p in self.participants:
            a = np.array(p["assignment"])
            sizes = sorted(np.bincount(a).tolist(), reverse=True)
            rows.append({"pid": p["pid"], "country": p["country"], "piles": len(sizes), "sizes": sizes, "max": sizes[0], "min": sizes[-1], "complete": len(a) == self.n and (a >= 0).all(), "distinct_statements": len(a)})
        return rows

    def label_scan(self):
        flagged = []
        total = 0
        empty = 0
        for p in self.participants:
            for lab in self.extras[p["pid"]]["pileLabels"]:
                total += 1
                if not lab.strip():
                    empty += 1
                if re.search(r"\d{4,}|@|https?:|01[0-9]-?\d{3,4}", lab):
                    flagged.append((p["pid"], lab))
        return {"labels": total, "empty": empty, "flagged_possible_identifier": flagged}

    # ---- boundary items for a solution
    def boundary(self, sol, thr=0.1):
        lab = np.array(sol["labels"])
        sil = sol["silhouetteMap"]["perPoint"]
        k = sol["k"]
        out = {}
        for i in range(self.n):
            c = lab[i]
            others = {cc: self.map_dist[i, np.where(lab == cc)[0]].mean() for cc in range(1, k + 1) if cc != c}
            near = min(others, key=others.get)
            out[i] = {"silhouette": sil[i], "nearest_other": near, "is_boundary": sil[i] < thr}
        return out

    def cluster_name(self, c):
        return self.names[c]["nameKo"] if c in self.names else ""

    def solution(self, k):
        return next(s for s in self.a["solutions"] if s["k"] == k)

    def pairs_of_interest(self):
        return self.a["pairDiagnostics"]
