-- Read-only reference repositories attached to a document-authoring task: the `doc-writer`
-- agent clones each as a sibling checkout it may read (to reuse existing solutions) but never
-- writes to. Serialized JSON array of { githubId, owner, name, defaultBranch, installationId? }.
ALTER TABLE blocks ADD COLUMN reference_repos TEXT;
