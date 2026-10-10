-- Role-scoped merge policy on the merge preset.
--
-- `class_rules_by_role` is a JSON partial map from workspace role (`admin` | `member` | `viewer`)
-- to that role's own per-change-class rule map — the same shape as `class_rules`, one tier in.
-- Composition is narrow-only in the domain (`narrowMergeClassRule`), so a role entry can only
-- make a class stricter than the base rules; it can never widen one.
--
-- `dry_run_roles` is a JSON array of the roles whose runs are forced into dry-run mode: the
-- pipeline runs in full and opens its pull request, but nothing merges.
--
-- Both are NOT NULL with empty defaults, so every existing row resolves to exactly its previous
-- behaviour — no role narrows anything, nobody is sandboxed. Mirrored on Node by the
-- `class_rules_by_role` / `dry_run_roles` text columns on the Drizzle `merge_threshold_presets`
-- table.
ALTER TABLE merge_threshold_presets ADD COLUMN class_rules_by_role TEXT NOT NULL DEFAULT '{}';
ALTER TABLE merge_threshold_presets ADD COLUMN dry_run_roles TEXT NOT NULL DEFAULT '[]';
