-- The GROUP a repo-sourced skill declares itself into (`group:` in its `SKILL.md` frontmatter).
--
-- A skill catalog grows past the point where one flat list is a usable picker, and a surface that
-- offers skills usually wants a SUBSET of it: a review task queues specialist review playbooks
-- ("Performance review", "Security review") and has no business offering a release-notes writer.
-- The group is what makes that filter possible without the picker guessing from a name.
--
-- Stored as the RAW declared value (lowercased and trimmed by the sync), not as the narrowed wire
-- vocabulary: a value this build does not know is shown back to its author by the management
-- surface rather than silently reclassified. Readers narrow with `normalizeSkillGroup`, which
-- lands an unknown value on the `other` shelf.
--
-- `NOT NULL DEFAULT 'other'` because every existing row predates the field and declared nothing:
-- unclassified is precisely what they are, and it is the same value the parser assigns a manifest
-- with no `group:`. The next sync of each source rewrites it from the manifest.

ALTER TABLE account_skills ADD COLUMN skill_group TEXT NOT NULL DEFAULT 'other';
