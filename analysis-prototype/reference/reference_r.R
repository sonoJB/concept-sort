# Reference cross-check script — WRITTEN BUT NOT EXECUTED in this
# environment (no R available locally or on Railway; no Docker/Podman/WSL
# to run it in either — see README.md in this directory).
#
# Intended dependencies (pin exact versions when actually run):
#   smacof (CRAN)
#   stats (base R, for hclust)
#
# Usage (once an environment exists):
#   Rscript reference_r.R

# Fixture B: 4-point square — mirrors analysis-prototype/fixtures/fixtures.ts
s2 <- sqrt(2)
fixtureB <- matrix(c(
  0, 1, s2, 1,
  1, 0, 1, s2,
  s2, 1, 0, 1,
  1, s2, 1, 0
), nrow = 4, byrow = TRUE)

library(smacof)
# type="ordinal" is nonmetric MDS with the "primary" approach to ties by
# default in this package; confirm the ties.method argument if fixture D
# (ties-heavy) is cross-checked, since this prototype's TS implementation
# uses the "secondary" approach (see isotonic.ts) — a primary-vs-secondary
# mismatch would show up as a small stress difference on tie-heavy fixtures
# and must not be misread as a bug.
fit <- smacof::mds(fixtureB, type = "ordinal", ndim = 2, itmax = 300, eps = 1e-9)
print(fit$conf)      # coordinates
print(fit$stress)    # smacof package's own stress value — CONFIRM its exact
                      # definition (Stress-1 vs raw) against the package docs
                      # before comparing directly to normalizedStress1 here.

# Ward reference via base R, on the SAME coordinates the TS implementation
# reached (paste TS-derived coordinates here once cross-checking).
d <- dist(fit$conf, method = "euclidean")
hc_d2 <- hclust(d^2, method = "ward.D2")  # ward.D2 expects squared-distance-aware input; confirm exact call convention against ?hclust before trusting blindly
print(hc_d2$merge)
print(hc_d2$height)

cat("\nREMINDER: this script has not actually been executed. Do not treat\n")
cat("any output above as an actual cross-check result until it has been\n")
cat("run for real and the numbers pasted into analysis-prototype/results/.\n")
