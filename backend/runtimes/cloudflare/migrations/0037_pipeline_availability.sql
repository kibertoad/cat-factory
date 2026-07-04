-- Pipeline launch availability: persist the `availability` field that was previously carried
-- on the domain entity but dropped at the persistence layer (same class of gap as migration
-- 0032's companion toggles).
--
-- `pipelines.availability` — how the pipeline may be LAUNCHED: `'one-off'` (only as a manual
--                            task), `'recurring'` (only attached to a schedule), or `'both'`.
--                            NULL/absent ⇒ unrestricted (`'both'`), so existing rows read
--                            unchanged (pre-1.0, no back-fill).

ALTER TABLE pipelines ADD COLUMN availability TEXT;
