-- Per-block choice of where acceptance / Playwright tests run: 'github_actions'
-- (project CI, against a service spun up in the same run) or 'ephemeral_env'
-- (the provisioned ephemeral environment for the run). Stored as TEXT; the
-- acceptance-testing agents fold it into their prompt. Nullable: existing blocks
-- have no preference recorded.
ALTER TABLE blocks ADD COLUMN test_target TEXT;
