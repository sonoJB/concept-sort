# External reference cross-check — NOT EXECUTED

This directory contains reference scripts written for cross-checking the
TypeScript SMACOF/Ward implementation in `src/lib/conceptAnalysis` against
established Python (`scikit-learn`) and R (`smacof`, `stats::hclust`)
implementations.

**These scripts have not been run in this environment.** Before writing
them, the following were checked, read-only, with no installation attempted:

| Tool | Check | Result |
|---|---|---|
| Docker | `docker --version` | not found (exit 127) |
| Docker daemon | `docker info` | not found (exit 127) |
| Podman | `podman --version` | not found (exit 127) |
| WSL | `wsl --status` | not installed (exit 50, points to `wsl --install`) |
| Local Python | `python --version` | Microsoft Store execution-alias stub only, not a real install (exit 49) |
| Local R | `which R` / `which Rscript` | not found |
| Railway container | `which python3/python/R/Rscript` (read-only `railway ssh`) | none found (Debian 12 bookworm, Node-only image) |

Per the task's explicit instruction, no installation was attempted (would
require admin rights / new system state) and the run was stopped at this
point rather than proceeding to app integration.

**Consequence:** the SMACOF and Ward implementations in this prototype are
internally self-consistent (see `analysis-prototype/scripts/verify.ts`,
`handcheck.ts`, `handcheck_ward.ts` — hand-derivable fixtures, stress
recomputation matches, monotone non-increase, seed reproducibility, Ward
formula matched against a direct ESS-increase calculation) but have **NOT**
been numerically cross-checked against `sklearn.manifold.smacof` /
`scipy.cluster.hierarchy.linkage(method="ward")` / R's `smacof`/`hclust`.

**This means: "implemented" — yes. "Verified against external reference" — no.**
Per the task's verification criteria, this prototype must not be reported as
verification-complete, and the app-integration step must not proceed on
this basis alone.

## How to actually run these when an environment becomes available

```bash
# Python side (requires scikit-learn, scipy, numpy — versions pinned in reference_python.py header)
python3 analysis-prototype/reference/reference_python.py

# R side (requires the `smacof` and base `stats` packages)
Rscript analysis-prototype/reference/reference_r.R
```

Both scripts read the same fixture values that appear in
`analysis-prototype/fixtures/fixtures.ts` (hardcoded inline here, since this
directory has no dependency on the TS build) and print stress/coordinates/
linkage in a format meant to be diffed by eye against
`analysis-prototype/results/` output from the TS side.
