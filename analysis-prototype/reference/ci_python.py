"""
CI-executed Python reference runner. Reads the shared fixtures JSON
(exportFixtures.ts output) and produces python-smacof-results.json /
python-ward-results.json / python-version-metadata.json for
compareReferences.ts to consume.

Pinned dependencies (see .github/workflows/concept-analysis-cross-validation.yml):
  numpy==1.26.4
  scipy==1.13.1
  scikit-learn==1.5.1

IMPORTANT, documented here rather than silently assumed:
- sklearn.manifold.smacof's public signature does not accept a per-pair
  weight matrix in this pinned version. This script therefore only calls it
  on fixtures whose weight matrix is uniform (all off-diagonal = 1) — which
  is true for every fixture we run it on, since the offDiagonalZero and
  ties fixtures are excluded from sklearn comparison anyway (see below).
- sklearn's nonmetric SMACOF historically has ambiguous behavior for
  dissimilarity=0 off-diagonal entries in some versions/code paths (treated
  close to "missing" internally in parts of the ties-handling logic). Per
  instructions, the offDiagonalZero fixture is NOT run through sklearn at
  all — this is recorded explicitly in the metadata output, not silently
  skipped.
- This script independently RECOMPUTES normalizedStress1 from sklearn's
  returned embedding using this project's own Stress-1 formula (isotonic
  fit via sklearn.isotonic.IsotonicRegression, weighted, on the same
  ascending-dissimilarity-rank ordering used in isotonic.ts), rather than
  trusting sklearn's own internally-reported stress value to already be in
  the same normalization convention. Both values are reported.
"""
import json
import sys
import platform
import numpy as np
import sklearn
from sklearn.manifold import smacof
from sklearn.isotonic import IsotonicRegression
from scipy.cluster.hierarchy import linkage, fcluster
import scipy

fixtures_path = sys.argv[1]
output_dir = sys.argv[2]

with open(fixtures_path, "r", encoding="utf-8") as f:
    fixtures = json.load(f)


def pairwise_distance(coords):
    coords = np.asarray(coords)
    n = coords.shape[0]
    d = np.zeros((n, n))
    for i in range(n):
        for j in range(n):
            d[i, j] = np.linalg.norm(coords[i] - coords[j])
    return d


def validate_init_shape(init, dissimilarity, n_components):
    """Defensive validation for the SMACOF init array, run immediately before
    every smacof() call. sklearn's public smacof() expects `init` shaped
    exactly (n_samples, n_components) — a plain 2D array, not wrapped in an
    extra leading dimension. Raises PYTHON_INIT_SHAPE_INVALID with a precise
    message instead of silently reshaping on mismatch.
    """
    n = dissimilarity.shape[0]
    if dissimilarity.ndim != 2 or dissimilarity.shape[0] != dissimilarity.shape[1]:
        raise ValueError(f"PYTHON_INIT_SHAPE_INVALID: dissimilarity is not square, got shape {dissimilarity.shape}")
    if init.ndim != 2:
        raise ValueError(f"PYTHON_INIT_SHAPE_INVALID: init.ndim must be 2, got {init.ndim} (shape {init.shape})")
    if init.shape[0] != n:
        raise ValueError(
            f"PYTHON_INIT_SHAPE_INVALID: init.shape[0] ({init.shape[0]}) must equal "
            f"dissimilarity.shape[0] ({n})"
        )
    if init.shape[1] != n_components:
        raise ValueError(
            f"PYTHON_INIT_SHAPE_INVALID: init.shape[1] ({init.shape[1]}) must equal "
            f"n_components ({n_components})"
        )


def recompute_normalized_stress1(dissimilarity, distance, n):
    """Independent re-implementation of this project's Stress-1 formula:
    disparities fit via weighted isotonic regression on ascending
    dissimilarity rank (uniform weight=1, since these fixtures have no
    missing/off-diagonal-zero pairs run through this path), denominator is
    the sum of squared CONFIGURATION distances — matching stress.ts exactly.
    """
    pairs = [(i, j) for i in range(n) for j in range(i + 1, n)]
    pairs.sort(key=lambda p: dissimilarity[p[0]][p[1]])
    y = np.array([distance[i][j] for i, j in pairs])
    x = np.arange(len(pairs))  # rank order is the isotonic x-axis
    ir = IsotonicRegression(increasing=True)
    disparity_sorted = ir.fit_transform(x, y)
    raw_stress = float(np.sum((disparity_sorted - y) ** 2))
    denom = float(np.sum(y ** 2))
    normalized = float(np.sqrt(raw_stress / denom)) if denom > 0 else None
    return raw_stress, normalized


smacof_results = {}
skipped = {}

for key, fx in fixtures["mds"].items():
    if key in ("ties", "offDiagonalZero"):
        skipped[key] = (
            "Excluded from sklearn comparison: sklearn.manifold.smacof's public API "
            "has no per-pair weight matrix and no independently-confirmed tie-handling "
            "convention matching this project's 'secondary' approach in this pinned "
            "version; off-diagonal dissimilarity=0 handling is not independently "
            "confirmed safe either. See ci_python.py module docstring."
        )
        continue

    dissimilarity = np.array(fx["dissimilarity"])
    init = np.array(fx["initialCoordinates"])
    n = dissimilarity.shape[0]
    n_components = fx["dimension"]

    # sklearn's public smacof() expects init shaped (n_samples, n_components)
    # directly — a plain 2D array. No reshape here; validate instead of
    # coercing, so a genuine shape mismatch surfaces as a clear error rather
    # than being silently "fixed" into some other unintended shape.
    validate_init_shape(init, dissimilarity, n_components)

    try:
        embedding, sklearn_stress, n_iter = smacof(
            dissimilarity,
            metric=False,
            n_components=n_components,
            init=init,
            n_init=1,
            max_iter=fx["maxIter"],
            eps=fx["eps"],
            random_state=0,
            normalized_stress=True,
            return_n_iter=True,
        )
    except TypeError:
        # Older sklearn without normalized_stress kwarg — retry without it,
        # and record that sklearn's own stress value in that case is its
        # legacy (non-normalized) convention, not necessarily Stress-1.
        embedding, sklearn_stress, n_iter = smacof(
            dissimilarity,
            metric=False,
            n_components=n_components,
            init=init,
            n_init=1,
            max_iter=fx["maxIter"],
            eps=fx["eps"],
            random_state=0,
            return_n_iter=True,
        )

    distance = pairwise_distance(embedding)
    raw_stress, normalized_stress1 = recompute_normalized_stress1(dissimilarity, distance, n)

    smacof_results[key] = {
        "coordinates": embedding.tolist(),
        "pairwiseDistance": distance.tolist(),
        "sklearnReportedStress": float(sklearn_stress),
        "recomputedRawStress": raw_stress,
        "recomputedNormalizedStress1": normalized_stress1,
        "nIter": int(n_iter),
        "initShape": list(init.shape),
    }

with open(f"{output_dir}/python-smacof-results.json", "w", encoding="utf-8") as f:
    json.dump({"results": smacof_results, "skipped": skipped}, f, indent=2)

# ---- Ward via SciPy ----
ward_points = np.array(fixtures["ward"]["tieFree"]["points"])
Z = linkage(ward_points, method="ward")
n_points = ward_points.shape[0]

candidate_partitions = {}
for k in range(1, n_points + 1):
    labels = fcluster(Z, t=k, criterion="maxclust")
    candidate_partitions[str(k)] = [int(x) - 1 for x in labels]  # 0-indexed to match TS

linkage_rows = []
for step, row in enumerate(Z):
    linkage_rows.append(
        {
            "step": step,
            "leftNode": int(row[0]),
            "rightNode": int(row[1]),
            "mergeDistance": float(row[2]),
            "mergedItemCount": int(row[3]),
        }
    )

with open(f"{output_dir}/python-ward-results.json", "w", encoding="utf-8") as f:
    json.dump({"linkage": linkage_rows, "originalCount": n_points, "candidatePartitions": candidate_partitions}, f, indent=2)

with open(f"{output_dir}/python-version-metadata.json", "w", encoding="utf-8") as f:
    json.dump(
        {
            "pythonVersion": platform.python_version(),
            "numpyVersion": np.__version__,
            "scipyVersion": scipy.__version__,
            "scikitLearnVersion": sklearn.__version__,
        },
        f,
        indent=2,
    )

print("Python reference results written to:", output_dir)
print("Skipped fixtures:", list(skipped.keys()))
