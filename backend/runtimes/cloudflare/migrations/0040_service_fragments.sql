-- Service-scoped best-practice prompt fragments.
--
-- A service (frame block) selects which best-practice / guideline fragments from the
-- universal pool are its programming standards; at run time the engine folds their
-- bodies into the system prompt of every agent under the service that carries the
-- `code-aware` trait. New services inherit the workspace default below.

-- Service-level (frame): the service's selected best-practice fragment ids (JSON array).
ALTER TABLE blocks ADD COLUMN service_fragment_ids TEXT;

-- Per-workspace default service-fragment selection: the ids new services inherit.
-- One row per workspace; the fragment ids are a JSON array.
CREATE TABLE workspace_fragment_defaults (
  workspace_id TEXT    NOT NULL PRIMARY KEY,
  fragment_ids TEXT    NOT NULL,
  updated_at   INTEGER NOT NULL
);
