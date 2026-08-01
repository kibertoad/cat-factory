import { sql } from 'drizzle-orm'
import { bigint, index, integer, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// The FOUNDATIONAL SERVICES tables, mirroring the Cloudflare D1 tables column-for-column
// (snake_case field names = column names) exactly as the rest of the Node schema does.
//
// One cohesive group — the tiered catalog of shared capabilities an Architect designs against
// (`foundational_services`), the API contract DOCUMENTS its consumers lazily read
// (`api_contracts`), and the repo links a sync keeps them fresh from
// (`foundational_service_sources`). Split out of `../schema.ts` so that module stays within its
// file-size budget; see backend/docs/adr/0031-foundational-services.md.
// ---------------------------------------------------------------------------

// Foundational services (backend/docs/adr/0031-foundational-services.md; mirror of D1 migration 0073).
// A tiered catalog of shared capabilities an Architect designs against, owner-scoped by an
// (owner_kind, owner_id) pair exactly like the prompt-fragment library. Identity and DOCUMENTS
// are separate tables on purpose: the catalog read runs on every design dispatch and must never
// load a contract body, while only the consumer steps — for only the services the design
// declared — read `api_contracts.body`.
export const foundationalServices = pgTable(
  'foundational_services',
  {
    service_id: text('service_id').notNull(),
    owner_kind: text('owner_kind').notNull(),
    owner_id: text('owner_id').notNull(),
    name: text('name').notNull(),
    summary: text('summary').notNull(),
    description: text('description').notNull().default(''),
    // JSON string[] of capability tags.
    capabilities: text('capabilities').notNull().default('[]'),
    source_id: text('source_id'),
    source_path: text('source_path'),
    pinned_commit: text('pinned_commit'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.owner_kind, t.owner_id, t.service_id] }),
    index('idx_foundational_services_owner')
      .on(t.owner_kind, t.owner_id)
      .where(sql`${t.deleted_at} IS NULL`),
    index('idx_foundational_services_source')
      .on(t.source_id)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
)

export const apiContracts = pgTable(
  'api_contracts',
  {
    owner_kind: text('owner_kind').notNull(),
    owner_id: text('owner_id').notNull(),
    service_id: text('service_id').notNull(),
    contract_id: text('contract_id').notNull(),
    format: text('format').notNull(),
    title: text('title').notNull(),
    // The document verbatim. Never selected by the catalog read (see the table note).
    body: text('body').notNull(),
    // Operations indexed ONCE at write time; JSON string[], empty for the TypeScript formats.
    operations: text('operations').notNull().default('[]'),
    omitted_operations: integer('omitted_operations').notNull().default(0),
    source_path: text('source_path'),
    source_sha: text('source_sha'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.owner_kind, t.owner_id, t.service_id, t.contract_id] }),
    index('idx_api_contracts_owner').on(t.owner_kind, t.owner_id, t.service_id),
  ],
)

export const foundationalServiceSources = pgTable(
  'foundational_service_sources',
  {
    id: text('id').primaryKey(),
    owner_kind: text('owner_kind').notNull(),
    owner_id: text('owner_id').notNull(),
    repo_owner: text('repo_owner').notNull(),
    repo_name: text('repo_name').notNull(),
    git_ref: text('git_ref').notNull().default('HEAD'),
    // 'directory' scans <dir_path>/<service>/; 'files' reads an explicit path list for ONE service.
    mode: text('mode').notNull().default('directory'),
    dir_path: text('dir_path').notNull().default(''),
    // JSON string[]; 'files' mode only.
    file_paths: text('file_paths').notNull().default('[]'),
    service_id: text('service_id'),
    service_name: text('service_name'),
    service_summary: text('service_summary'),
    last_synced_commit: text('last_synced_commit'),
    last_synced_at: bigint('last_synced_at', { mode: 'number' }),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('idx_foundational_sources_unique').on(
      t.owner_kind,
      t.owner_id,
      t.repo_owner,
      t.repo_name,
      t.git_ref,
      t.dir_path,
    ),
    index('idx_foundational_sources_owner')
      .on(t.owner_kind, t.owner_id)
      .where(sql`${t.deleted_at} IS NULL`),
    // The push-webhook fan-out looks sources up by the only thing a delivery names — the repo —
    // across every tier, so it is indexed on that pair rather than on an owner.
    index('idx_foundational_sources_repo')
      .on(t.repo_owner, t.repo_name)
      .where(sql`${t.deleted_at} IS NULL`),
    // The autorefresh sweep drains the oldest-synced live sources in bounded batches.
    index('idx_foundational_sources_stale')
      .on(t.last_synced_at)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
)
