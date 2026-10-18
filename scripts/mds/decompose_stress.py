"""Decomposes the change between the previously DISPLAYED Stress-1 and the new Stress-1 into two separate effects:
  (1) convergence: the old engine stopped at iteration 2 (unconverged); the same old DEFINITION evaluated at the
      converged solution is lower,
  (2) definition: at the converged solution, the old/scikit-learn-style definition sqrt(raw / sum d^2) with normalised
      disparities is larger than Kruskal's Stress-1 (disparity scale optimised).
Usage: python decompose_stress.py <diag_old.json> <bundle_dir> <out.json>"""
import json
import sys

diag = json.load(open(sys.argv[1], encoding="utf-8"))
bdir, out = sys.argv[2], sys.argv[3]
res = {
    "explanation": "old displayed value = old definition at an UNCONVERGED iteration-2 configuration; new value = Kruskal definition at the converged solution. total change = convergence effect + definition effect (they are not both 'convergence improvement').",
}
for scope in ["KR", "JP", "ALL"]:
    b = json.load(open(f"{bdir}/bundle_{scope}.json", encoding="utf-8"))["bundle"]
    p = b["analysis"]["primary"]
    old = diag[scope]["v1 as deployed (8 inits, 300 it)"]["selected"]
    old_shown = old["stress1"]
    old_def_conv = p["stress1V1Definition"]
    new = p["stress1"]
    res[scope] = {
        "previously_displayed_stress1_old_engine_unconverged_2_iterations": old_shown,
        "old_engine_raw_stress_at_that_point": old["rawStress"],
        "old_definition_at_converged_solution": old_def_conv,
        "kruskal_stress1_at_converged_solution": new,
        "converged_raw_stress": p["rawStress"],
        "total_change": new - old_shown,
        "effect_of_convergence (old definition: unconverged -> converged)": old_def_conv - old_shown,
        "effect_of_definition (old definition -> Kruskal, same converged coordinates)": new - old_def_conv,
        "share_of_total_from_convergence": (old_def_conv - old_shown) / (new - old_shown),
        "share_of_total_from_definition": (new - old_def_conv) / (new - old_shown),
        "note": "For JP and ALL the 'previously displayed' value is the old engine re-run on the MAIN data with the deployed budget (no stored MAIN run existed for those scopes); for KR it equals the stored production run (0.44627).",
    }
json.dump(res, open(out, "w"), indent=1, ensure_ascii=False)
print(json.dumps(res, indent=1, ensure_ascii=False))
