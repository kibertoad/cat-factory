-- Per-workspace CAPABILITY CREDENTIALS (sealed) — the tenant-scoped home for the secrets a
-- registered capability (a tool server, a generative binary integration) declares by name.
--
-- The shipped resolver read these off the DEPLOYMENT'S environment, which is a single-tenant
-- answer: one process serves every workspace, so one variable served them all. This is the same
-- shape every other credential in the platform already uses — sealed at rest by the SecretCipher
-- (tag 'cat-factory:capability-credentials'), delivered to the agent out of band, edited in the
-- UI. The environment resolver stays wired BEHIND this store as the fallback.
--
-- ONE ROW PER WORKSPACE holding the whole set: the read is on the dispatch path, the set is small
-- and bounded (<= 100), and both the resolver and the settings view want all of it — so a row per
-- key would buy a finer write at the cost of turning one read into N.
CREATE TABLE capability_credentials (
  workspace_id TEXT    NOT NULL,
  credentials  TEXT    NOT NULL,               -- sealed JSON of CapabilityCredentialEntry[] (key + value)
  summary      TEXT    NOT NULL DEFAULT '[]',  -- non-secret JSON of CapabilityCredentialRef[] (key + updatedAt)
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id)
);
