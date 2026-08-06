# Prototype verification summary (internal only — no external cross-check)

Run via `npx tsx analysis-prototype/scripts/verify.ts` on Node v24.18.0.

- **227 passed, 0 failed** (up from the first pass's 175; 52 tests added
  during pre-commit review: `runDimensionDiagnostics` unit tests, 1D-6D
  column-structure checks, maxIter-exhaustion, all-inits-failed, a tie-free
  Ward fixture + linkage node-ID convention checks, k=1/k=n/out-of-range
  cluster-count boundary handling, and N=0/N=1 analysis-status handling).
- One test used too few `nInit` restarts for a known multi-local-optima
  fixture (4-point square) in the first pass — fixed by raising `nInit`,
  not an algorithm bug (see inline comment in `verify.ts`).
- **One real bug found and fixed during this pre-commit review**: an
  all-weights-zero ("every pair marked missing") input threw an uncaught
  exception instead of returning a structured failure. Fixed with an
  explicit `NO_WEIGHTED_PAIRS` early-return in
  `src/lib/conceptAnalysis/smacof.ts`, mirroring the existing
  `INSUFFICIENT_ITEMS`/`DIMENSION_TOO_HIGH` guards. This is a crash-safety
  fix for a genuine edge case, not a numerical/statistical correctness
  change, and required no changes to the core SMACOF/Ward math.
- `handcheck.ts`: fixture A (3-point degenerate collinear triangle)
  hand-derived and matched to ~1e-15 stress.
- `handcheck_ward.ts`: Ward first-merge distance hand-derived from the
  direct ESS-increase formula for a singleton pair and matched exactly
  (`mergeDistance² = 2 × ESS_increase` for the n=1,n=1 case — this internal
  identity was verified directly, but whether this numeric *convention*
  matches SciPy/R's exact reported scale has NOT been externally confirmed).
- `csvPrototype.ts`: KR/JP/ALL CSVs generated to a temp dir, confirmed UTF-8
  BOM present and no PII field names present in every file, temp dir deleted
  after the check.
- `performance.ts`: real timings on the 47-statement synthetic fixture,
  Node v24.18.0 only (Node 22 not installed locally — Railway's Node
  v22.23.1 was confirmed via `railway ssh`, but the prototype itself was not
  executed there per instructions forbidding Railway execution this step).

## Known limitation

No numeric cross-check against scikit-learn/SciPy or R's `smacof`/`hclust`
has been performed — no Python, R, Docker, Podman, or WSL is available in
this environment (see `analysis-prototype/reference/README.md`). This
prototype is **implemented and internally verified**, not **externally
verified**. Per the task's explicit criteria, it must not be reported as
verification-complete, and app integration should not proceed on this
basis alone.
