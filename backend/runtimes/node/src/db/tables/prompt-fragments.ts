import { sql } from 'drizzle-orm'
import { bigint, index, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// The PROMPT-FRAGMENT LIBRARY tables (ADR 0006): the tenant-scoped catalog of
// best-practice standards an agent's system prompt folds in, plus the two tables that
// exist only to serve it — the model-generated condensed briefs, and the repo directories
// a tier syncs its Markdown guideline files from — and the per-workspace row naming which
// fragments a new service inherits.
//
// Split out of `../schema.ts` so that module stays inside its size budget, exactly as
// `tables/identity.ts`, `tables/vcs.ts` and `tables/settings.ts` were; it re-exports
// everything here, so every importer (and drizzle-kit, which follows the re-export) still
// reaches these through `db/schema.js`. Columns mirror the Cloudflare D1 tables
// one-for-one, per the runtime-symmetry rule.
// ---------------------------------------------------------------------------

// Per-workspace default service-fragment selection (mirror of D1 migration 0040). One
// row per workspace; the best-practice fragment ids new services inherit, JSON array.
export const workspaceFragmentDefaults = pgTable('workspace_fragment_defaults', {
  workspace_id: text('workspace_id').primaryKey(),
  fragment_ids: text('fragment_ids').notNull(),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
})

// Prompt-fragment library (ADR 0006; mirror of D1 migration 0020). The managed,
// tenant-scoped catalog of best-practice fragments, scoped by an (owner_kind,
// owner_id) pair so one table backs both the account and workspace tiers. JSON-shaped
// columns (`applies_to`, `tags`) are `text`; a tombstone (`deleted_at`) suppresses an
// inherited or removed-upstream fragment.
export const promptFragments = pgTable(
  'prompt_fragments',
  {
    fragment_id: text('fragment_id').notNull(),
    owner_kind: text('owner_kind').notNull(),
    owner_id: text('owner_id').notNull(),
    version: text('version').notNull(),
    title: text('title').notNull(),
    category: text('category'),
    summary: text('summary').notNull(),
    body: text('body').notNull(),
    // The short version this tier LINKED (hand-authored, or a sourced file's `brief:`
    // frontmatter), folded for implementer kinds in place of `body`. Null ⇒ a long body is
    // condensed automatically into `fragment_briefs`.
    brief: text('brief'),
    applies_to: text('applies_to'),
    tags: text('tags'),
    source_id: text('source_id'),
    source_path: text('source_path'),
    source_sha: text('source_sha'),
    doc_source: text('doc_source'),
    doc_external_id: text('doc_external_id'),
    doc_via_workspace_id: text('doc_via_workspace_id'),
    resolved_at: bigint('resolved_at', { mode: 'number' }),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.owner_kind, t.owner_id, t.fragment_id] }),
    index('idx_prompt_fragments_owner')
      .on(t.owner_kind, t.owner_id)
      .where(sql`${t.deleted_at} IS NULL`),
    index('idx_prompt_fragments_source')
      .on(t.source_id)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
)

// Model-GENERATED condensed briefs for long best-practice standards that link none of their
// own (mirror of D1 migration 0069). Derived data with its own lifecycle — regenerated when
// `body_fingerprint` stops matching the body resolved at run time, dropped with its fragment —
// which is why it is a table of its own rather than more columns on `prompt_fragments`: it must
// also cover a BUILT-IN fragment, which has no managed row, and stay clear of the tier merge's
// shadow/tombstone semantics. Scoped by the owner of the tier that won the merge (a builtin-tier
// entry is scoped to the resolving workspace's account), so a row is bound to a tenant exactly
// like the fragment it condenses. The PK leads with the owner pair, which is the only read shape.
// An EMPTY `brief` is a real state — "this body was condensed and the result was unusable" — kept
// so a standard that cannot be usefully shortened is not re-condensed on every dispatch forever;
// it self-clears when `body_fingerprint` stops matching. See the D1 0069 header for the full rule.
export const fragmentBriefs = pgTable(
  'fragment_briefs',
  {
    owner_kind: text('owner_kind').notNull(),
    owner_id: text('owner_id').notNull(),
    fragment_id: text('fragment_id').notNull(),
    body_fingerprint: text('body_fingerprint').notNull(),
    brief: text('brief').notNull(),
    model: text('model').notNull(),
    generated_at: bigint('generated_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.owner_kind, t.owner_id, t.fragment_id] })],
)

// A repo directory linked as a source of Markdown guideline files (ADR 0006 §3;
// mirror of D1 migration 0020). At most one live source per (owner, repo, ref, dir) —
// the unique index is the upsert key; a partial owner index powers the list.
export const fragmentSources = pgTable(
  'fragment_sources',
  {
    id: text('id').primaryKey(),
    owner_kind: text('owner_kind').notNull(),
    owner_id: text('owner_id').notNull(),
    repo_owner: text('repo_owner').notNull(),
    repo_name: text('repo_name').notNull(),
    git_ref: text('git_ref').notNull().default('HEAD'),
    dir_path: text('dir_path').notNull().default(''),
    // Head commit sha of the source dir at the last sync (name kept for column stability;
    // it no longer stores the former tree-listing digest). Powers the staleness probe.
    last_synced_sha: text('last_synced_sha'),
    last_synced_at: bigint('last_synced_at', { mode: 'number' }),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('idx_fragment_sources_unique').on(
      t.owner_kind,
      t.owner_id,
      t.repo_owner,
      t.repo_name,
      t.git_ref,
      t.dir_path,
    ),
    index('idx_fragment_sources_owner')
      .on(t.owner_kind, t.owner_id)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
)
