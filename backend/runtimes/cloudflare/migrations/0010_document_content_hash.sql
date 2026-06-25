-- A cheap content-change digest (FNV-1a hex of the normalized Markdown `body`) on each
-- imported document projection, so a re-import whose body is byte-for-byte unchanged is a
-- no-op (the existing row, block link and synced time are preserved). Defaults to '' for
-- pre-existing rows; the next import recomputes it.
ALTER TABLE documents ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
