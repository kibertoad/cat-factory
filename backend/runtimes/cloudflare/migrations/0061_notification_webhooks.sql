-- Outbound notification webhook: ONE endpoint per workspace that receives the workspace's
-- notifications as they are raised. This is the delivery channel a HEADLESS integration needs —
-- it has no in-app inbox to watch and no browser to hold a WebSocket open — and it exists chiefly
-- so a public-API run that PARKS on a human decision reaches its caller by push rather than by
-- polling. See backend/docs/adr/0047-headless-clarification-loop.md (D3).
--
-- `secret_sealed` is the signing secret, encrypted with the deployment SecretCipher; it is never
-- read back over the API (the projection reports only whether one is set). `types` is a JSON array
-- of notification types; EMPTY means "the defaults" (the parking + actionable-tail types), not
-- "everything", so registering an endpoint can't accidentally fire-hose every operator card at it.
CREATE TABLE notification_webhooks (
  workspace_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  types TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  secret_sealed TEXT,
  updated_at INTEGER NOT NULL
);
