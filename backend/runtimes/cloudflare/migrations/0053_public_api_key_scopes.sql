-- Per-key permission scopes for the inbound public-API keys (initiative: public API expansion,
-- item #13). A key now carries a `scope` on the `/api/v1` surface — an inclusive ladder
-- (read ⊂ write ⊂ admin) the controller gates each endpoint on: reads need `read`, non-destructive
-- mutations need `write`, and destructive / merge-adjacent operations (e.g. DELETE a task) need
-- `admin`. Existing keys backfill to `write` — they keep every capability the surface shipped
-- before scopes existed (all of it read/write-level) but do NOT auto-gain the new destructive
-- power, which must be minted explicitly. Mirrored on Node by the `scope` column on the Drizzle
-- `public_api_keys` table.
ALTER TABLE public_api_keys ADD COLUMN scope TEXT NOT NULL DEFAULT 'write';
