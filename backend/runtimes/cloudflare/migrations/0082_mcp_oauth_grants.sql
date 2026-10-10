-- Per-workspace OAUTH GRANTS for remote (http) MCP tool servers (sealed).
--
-- A tool server declares its credentials by NAME and the value is resolved per dispatch through
-- the capability-credential chain, which is the right answer for a static token and no answer at
-- all for the OAuth-first vendor ecosystem (Figma, Atlassian, Slack and Linear remote MCP): those
-- servers issue a token to a CLIENT after a person authorises it, and the token expires. This is
-- the home for what comes out of that: the access token, the refresh token, and the non-secret
-- summary the connection panel renders.
--
-- Sealed at rest by the SecretCipher (tag 'cat-factory:mcp-oauth'), so the row carries no token in
-- the clear and can ride the mothership's persistence RPC, exactly like capability_credentials.
--
-- ONE ROW PER (workspace, server), unlike the one-blob-per-workspace credential store beside it.
-- The writes differ: a credential row is edited by a human filling in a checklist, while a grant
-- row is rewritten by a REFRESH on the dispatch path, and two dispatches refreshing two different
-- servers at once is the ordinary case. Per-server rows keep those writes off each other, and the
-- rev then only settles a race between two refreshes of the SAME grant, which is what it is for.
CREATE TABLE mcp_oauth_grants (
  workspace_id TEXT    NOT NULL,
  server_id    TEXT    NOT NULL,               -- McpServerDefinition.id
  tokens       TEXT    NOT NULL,               -- sealed JSON: access/refresh token, expiry, scope
  summary      TEXT    NOT NULL DEFAULT '{}',  -- non-secret JSON the operator surface renders
  rev          INTEGER NOT NULL DEFAULT 0,     -- optimistic concurrency for the refresh path
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, server_id)
);
