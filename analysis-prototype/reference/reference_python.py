"""
Reference cross-check script — WRITTEN BUT NOT EXECUTED in this environment
(no Python available locally or on Railway; no Docker/Podman/WSL to run it
in either — see README.md in this directory).

Intended dependencies (pin exact versions when actually run and record them
in the results file):
  numpy
  scipy
  scikit-learn

Usage (once an environment exists):
  python3 reference_python.py
"""
import numpy as np
from sklearn.manifold import smacof
from scipy.cluster.hierarchy import linkage, fcluster

# Fixture B: 4-point square — mirrors analysis-prototype/fixtures/fixtures.ts
sqrt2 = 2 ** 0.5
fixture_b = np.array([
    [0, 1, sqrt2, 1],
    [1, 0, 1, sqrt2],
    [sqrt2, 1, 0, 1],
    [1, sqrt2, 1, 0],
])

# NOTE: sklearn's smacof() nonmetric mode treats an off-diagonal 0 in the
# dissimilarity matrix ambiguously in older versions (historically conflated
# with "missing"; verify this explicitly against the installed sklearn
# version's changelog/docstring before trusting output on fixture E, which
# has genuine off-diagonal zeros). Fixture B has no off-diagonal zeros, so it
# is safe to use unmodified for this comparison.
coords, stress = smacof(
    fixture_b,
    n_components=2,
    metric=False,
    n_init=12,
    max_iter=300,
    eps=1e-9,
    random_state=42,
)
print("sklearn smacof coords:\n", coords)
print("sklearn smacof stress (raw, sklearn's own definition — CONFIRM against")
print("  sklearn docs whether this matches Kruskal Stress-1 or a different")
print("  normalization before comparing directly to normalizedStress1 here):", stress)

# Ward reference via scipy, on the SAME coordinates the TS implementation reached
# (paste TS-derived coordinates here once cross-checking; do not compare
# Ward output on two DIFFERENT coordinate sets).
Z = linkage(coords, method="ward")
print("\nscipy ward linkage matrix:\n", Z)
labels_k2 = fcluster(Z, t=2, criterion="maxclust")
print("k=2 partition:", labels_k2)

print("\nREMINDER: this script has not actually been executed in the")
print("Claude Code environment used to build this prototype. Do not treat")
print("any output above as an actual cross-check result until it has been")
print("run for real and the numbers pasted into analysis-prototype/results/.")
