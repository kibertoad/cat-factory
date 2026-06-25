-- Document-backed prompt fragments: a managed fragment whose body is a LIVING
-- external document (a Confluence/Notion page or a GitHub file) rather than a
-- frozen snapshot. `doc_source` + `doc_external_id` record which page the body
-- comes from; `resolved_at` is when it was last re-read from the source (so a
-- run can TTL-gate the live refresh). All NULL for hand-authored / repo-sourced
-- / built-in fragments. `body` holds the last-resolved snapshot (the fallback).
-- `doc_via_workspace_id` is the workspace whose stored source connection re-reads
-- the page at run time (fixed at link time, since credentials are per-workspace),
-- so an account-tier fragment refreshes through one connection rather than each
-- consuming workspace's own.
ALTER TABLE prompt_fragments ADD COLUMN doc_source           TEXT;
ALTER TABLE prompt_fragments ADD COLUMN doc_external_id      TEXT;
ALTER TABLE prompt_fragments ADD COLUMN doc_via_workspace_id TEXT;
ALTER TABLE prompt_fragments ADD COLUMN resolved_at          INTEGER;
