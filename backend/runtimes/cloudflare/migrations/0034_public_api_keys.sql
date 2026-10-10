-- Inbound public-API keys: the credentials external systems present to the `/api/v1` surface.
-- The secret is stored ONLY as a one-way peppered hash (HMAC-SHA256(secret, ENCRYPTION_KEY)) —
-- never plaintext, never recoverable. `id` (a `pak_*`) is the non-secret lookup index embedded in
-- the raw `cf_live_<id>.<secret>` key. Mirrored on Node by the `public_api_keys` Drizzle table.
CREATE TABLE public_api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  label TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX idx_public_api_keys_workspace ON public_api_keys (workspace_id);

-- Headless marker for the public-API "initiative" runs: a block created purely to anchor an
-- external run is `internal = 1` and excluded from every board projection (never rendered).
-- Mirrored on Node by the `internal` column on the Drizzle `blocks` table.
ALTER TABLE blocks ADD COLUMN internal INTEGER;

-- `public = 1` marks a pipeline callable via the public API (`POST /api/v1/initiatives`).
-- Mirrored on Node by the `public` column on the Drizzle `pipelines` table.
ALTER TABLE pipelines ADD COLUMN public INTEGER;
