-- CONDENSED BEST-PRACTICE STANDARDS ("briefs") for implementer kinds.
--
-- An implementer kind (coder / fixer / ci-fixer / conflict-resolver — the `brief-standards`
-- trait) re-sends its whole system prompt on every turn of a long agentic loop, so a long
-- standard is billed again and again. A `brief` states the same standard tersely and is folded
-- in place of the body for exactly those kinds.
--
-- Two changes here, in the two places the two SOURCES of a brief belong:
--
--  1. `prompt_fragments.brief` — the short version a tenant LINKS to its own fragment
--     (hand-authored in the library editor, or the `brief:` frontmatter key of a repo-sourced
--     guideline file). Until now only the code-authored built-in tier could carry one, so a
--     managed standard — including one overriding a built-in id — always folded in full.
--
--  2. `fragment_briefs` — the model-GENERATED condensation for a long standard that has no
--     linked one, produced on the first implementer dispatch that folds it and reused by every
--     later one. Derived data with its own lifecycle (regenerated, never authored, safe to
--     drop), which is why it is its own table rather than more columns on `prompt_fragments`:
--     it also has to cover a BUILT-IN / deployment-registered fragment, which has no managed
--     row at all, and it must stay clear of the tier merge's shadow/tombstone semantics.
--
-- `body_fingerprint` is the staleness signal — a length-prefixed digest of the body that was
-- condensed. A mismatch against the body resolved at run time means the standard moved (an
-- edit, a repo resync, a re-resolved living Confluence/Notion page) and the brief is
-- regenerated, which is how "regenerate when the source document changes" needs no change feed.
--
-- Scope is the (owner_kind, owner_id) of the tier that WON the merge for that id, so a row is
-- bound to a tenant exactly like the fragment it condenses. A `builtin`-tier entry owns no row
-- of its own and is scoped to the resolving workspace's ACCOUNT, so a deployment-wide standard
-- is condensed once per account rather than once per board.
--
-- Mirrors the Drizzle `promptFragments.brief` column + `fragmentBriefs` table on the Node
-- facade. See docs/initiatives/auto-generated-fragment-briefs.md.

ALTER TABLE prompt_fragments ADD COLUMN brief TEXT;

CREATE TABLE IF NOT EXISTS fragment_briefs (
  owner_kind       TEXT    NOT NULL,          -- 'account' | 'workspace'
  owner_id         TEXT    NOT NULL,          -- account id or workspace id
  fragment_id      TEXT    NOT NULL,          -- the stable id `prompt_fragments` keys on
  body_fingerprint TEXT    NOT NULL,          -- digest of the body this condenses
  brief            TEXT    NOT NULL,
  model            TEXT    NOT NULL,          -- `provider:model` that produced it
  generated_at     INTEGER NOT NULL,
  PRIMARY KEY (owner_kind, owner_id, fragment_id)
);

-- The only read shape: every brief for one owner scope, loaded once per dispatch and indexed
-- in memory (never a point read per fragment). The primary key already leads with the pair,
-- so no extra index is needed.
