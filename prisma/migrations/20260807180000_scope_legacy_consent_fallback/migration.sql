-- Data correction only (no schema change).
--
-- Gate 2B finding: legacyConsentFallbackEnabled is intended for exactly one
-- pre-existing project — src/lib/consent.ts documents LEGACY_CONSENT_BODY_KO
-- as belonging to "the single pre-existing project" (rrrvvnux, per
-- scripts/cleanup-project-data.ts's --keep-project=rrrvvnux /
-- DELETE_OTHER_PROJECTS_AND_RESET_RRRVVNUX_RESPONSES confirmation string).
--
-- The prior multilingual migration (20260805233213) backfilled
-- legacyConsentFallbackEnabled=true onto every project that existed at that
-- time, not just rrrvvnux. This statement re-scopes it to rrrvvnux only, for
-- rows still set to true as of when this migration runs.
--
-- Any project created after 20260805233213 already gets the schema default
-- (legacyConsentFallbackEnabled=false) and is unaffected by this statement.
-- No other column is touched.
UPDATE "Project"
SET "legacyConsentFallbackEnabled" = false
WHERE "slug" <> 'rrrvvnux'
  AND "legacyConsentFallbackEnabled" = true;
