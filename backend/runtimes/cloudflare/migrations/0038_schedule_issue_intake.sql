-- Issue-intake configuration for recurring schedules whose pipeline pulls work
-- from the workspace's issue tracker (the bug-triage `bug-intake` step): the
-- source, board scope, predicates, and the GitHub in-progress label, as one JSON
-- blob (see `issueIntakeConfigSchema` in @cat-factory/contracts). NULL = the
-- schedule has no intake (every schedule today).
ALTER TABLE pipeline_schedules ADD COLUMN issue_intake TEXT;
