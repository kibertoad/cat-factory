-- Public-API keys become account-level credentials that may be limited to a subset of the account's
-- workspaces (backend/docs/adr/0067-directory-sync.md). A key with `all_workspaces = 1` reaches
-- every workspace in its account, including later ones; otherwise it reaches exactly the workspaces
-- granted in `public_api_key_workspaces`. Every existing key keeps the one workspace it had. The
-- grant table carries `workspace_id`, so deleting a board removes its grants through the shared
-- workspace cascade, where it used to delete the key row itself.
CREATE TABLE public_api_key_workspaces (
  key_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  PRIMARY KEY (key_id, workspace_id)
);

CREATE INDEX idx_public_api_key_workspaces_workspace ON public_api_key_workspaces (workspace_id);

INSERT INTO public_api_key_workspaces (key_id, workspace_id)
  SELECT id, workspace_id FROM public_api_keys;

ALTER TABLE public_api_keys ADD COLUMN all_workspaces INTEGER NOT NULL DEFAULT 0;

DROP INDEX idx_public_api_keys_workspace;
ALTER TABLE public_api_keys DROP COLUMN workspace_id;

CREATE INDEX idx_public_api_keys_account ON public_api_keys (account_id);
