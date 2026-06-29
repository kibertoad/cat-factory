-- Generalize the self-hosted runner pool into a discriminated "agent runner backend":
-- a `kind` column selects WHICH backend the row configures (`manifest` = the BYO HTTP
-- scheduler pool, `kubernetes` = native per-run pods, future `nomad`/`eks`/…). The
-- existing `manifest_json` column now holds the whole discriminated config blob (its
-- physical name is kept). Existing rows are the manifest backend, so default to it.
ALTER TABLE runner_pool_connections ADD COLUMN kind TEXT NOT NULL DEFAULT 'manifest';
