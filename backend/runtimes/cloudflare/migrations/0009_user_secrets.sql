-- Generic per-USER secrets — token-style credentials keyed by (user_id, kind) (a GitHub
-- PAT today; future repository/provider tokens as new kinds with NO schema change). The
-- secret is single-system-key ciphertext (`secret_cipher`); non-secret fields ride in
-- `metadata_json` (e.g. {"apiBase":"…"}). Resolved by the run initiator at execution time.
CREATE TABLE user_secrets (
  user_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,        -- github_pat | …
  label         TEXT NOT NULL,
  secret_cipher TEXT NOT NULL,        -- system-key ciphertext of the raw secret
  metadata_json TEXT,                 -- JSON of non-secret metadata, or NULL
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
);
