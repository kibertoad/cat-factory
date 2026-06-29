-- Drop the per-user document-source connection store. It existed only to hold Claude
-- Design's per-user PAT (`credentialScope: 'user'`); that provider has been removed (its
-- live read is claude.ai-login-bound, with no per-workspace/per-user service token a
-- headless backend can use), and every remaining document source is workspace-scoped. No
-- data migration: per the pre-1.0 "no backwards compatibility" policy, the stale rows are
-- simply dropped.
DROP TABLE IF EXISTS user_document_connections;
