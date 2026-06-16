-- Two-App tiering for repository provisioning (ADR 0005). A workspace may now be
-- connected via either the default (restricted) GitHub App or a privileged App
-- that carries `Administration: write`. Since an installation id belongs to
-- exactly one App, record which App owns each installation so token minting routes
-- to the right key. Existing rows predate the tier and were created via the
-- default App, so a NULL `app_id` is interpreted as "the default App".
ALTER TABLE github_installations ADD COLUMN app_id TEXT;
