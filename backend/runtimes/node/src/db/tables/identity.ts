import { sql } from 'drizzle-orm'
import {
  bigint,
  doublePrecision,
  index,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// The TENANCY & IDENTITY tables, mirroring the Cloudflare D1 tables column-for-column
// (snake_case field names = column names) exactly as the rest of the Node schema does.
//
// One cohesive group — who exists and what they belong to: the board (`workspaces`) and
// person (`users`) roots every other table keys off, the login identities and account /
// membership graph layered on them, the two roster-growth paths (`account_invitations`,
// `password_reset_tokens`), and the per-account rows that configure a tenant
// (`email_connections`, `account_settings`). Split out of `../schema.ts` so that module
// stays inside its (shrink-only) size budget; `../schema.ts` re-exports everything here,
// so every existing `from '../db/schema.js'` import is unaffected and drizzle-kit still
// sees the tables through that entry point.
//
// This is also where the schema's FK targets live: `users.id` and `workspaces.id` are the
// only two columns anything references. Keeping the referencing credential tables in
// `../schema.ts` importing FROM here (rather than the reverse) is what keeps the module
// graph acyclic.
// ---------------------------------------------------------------------------

export const workspaces = pgTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    account_id: text('account_id'),
    owner_user_id: text('owner_user_id'),
    // Workspace RBAC access mode ('account' | 'restricted'); default preserves the legacy
    // "every account member sees it" behaviour so no existing row changes.
    access_mode: text('access_mode').notNull().default('account'),
  },
  // listVisible filters by owner_user_id (legacy) and account_id (membership scope).
  (t) => [
    index('idx_workspaces_owner').on(t.owner_user_id),
    index('idx_workspaces_account').on(t.account_id),
  ],
)

// Canonical user identity (decoupled from GitHub). Everything else keys off users.id.
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    email: text('email'),
    avatar_url: text('avatar_url'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('idx_users_email')
      .on(t.email)
      .where(sql`email IS NOT NULL`),
  ],
)

// A linked login identity for a user. (provider, subject) is unique.
export const userIdentities = pgTable(
  'user_identities',
  {
    // ON DELETE RESTRICT: a users row can't be removed while a login identity still points
    // at it — the DB-level guard against the dangling-identity orphaning incident.
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    provider: text('provider').notNull(),
    subject: text('subject').notNull(),
    secret: text('secret'),
    metadata: text('metadata'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.subject] }),
    index('idx_user_identities_user').on(t.user_id),
  ],
)

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    name: text('name').notNull(),
    github_account_login: text('github_account_login'),
    // The user who owns a personal account (its account-of-one). Null for orgs.
    // ON DELETE RESTRICT: can't drop a user that still owns a personal account.
    owner_user_id: text('owner_user_id').references(() => users.id, { onDelete: 'restrict' }),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    // The default cloud provider new services in this account inherit.
    default_cloud_provider: text('default_cloud_provider'),
    // The account-tier monthly spend budget (base pricing currency). Null = none.
    spend_monthly_limit: doublePrecision('spend_monthly_limit'),
  },
  // Enforce one personal account per user (a correctness constraint, not just a
  // lookup index) — the partial unique index `findPersonalByUser` relies on.
  (t) => [
    uniqueIndex('idx_accounts_personal')
      .on(t.owner_user_id)
      .where(sql`type = 'personal'`),
  ],
)

export const memberships = pgTable(
  'memberships',
  {
    account_id: text('account_id').notNull(),
    // ON DELETE RESTRICT: a users row can't be removed while it still holds a membership.
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // Combinable roles (admin / developer / product) as a CSV; defaults to developer.
    roles: text('roles').notNull().default('developer'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.account_id, t.user_id] }),
    index('idx_memberships_user').on(t.user_id),
  ],
)

// Workspace membership (workspace RBAC, migration 0052). Scopes a user to a board with a
// single-valued workspace role; a restricted board reads it as the sole grant, an
// account-mode board honours it as an upgrade-only overlay.
export const workspaceMembers = pgTable(
  'workspace_members',
  {
    // ON DELETE CASCADE: a deleted board takes its roster (the Drizzle FK; the D1 side
    // relies on the workspace-delete cascade list since D1 doesn't enforce FKs).
    workspace_id: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    // ON DELETE RESTRICT: mirrors memberships.user_id — can't drop a user with a live row.
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // Single value: admin | member | viewer (a strict hierarchy, not a CSV set).
    role: text('role').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    // Audit: who granted the row; null for system grants (creator auto-enroll). No FK.
    added_by_user_id: text('added_by_user_id'),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.user_id] }),
    // Drives listWorkspaceIdsForUser + the visibility subquery.
    index('idx_workspace_members_user').on(t.user_id),
  ],
)

// Per-account transactional-email sender (UI-onboarded). The provider API key is
// sealed at rest (SecretCipher), never plaintext.
export const emailConnections = pgTable('email_connections', {
  account_id: text('account_id').primaryKey(),
  provider: text('provider').notNull(),
  from_address: text('from_address').notNull(),
  api_key_cipher: text('api_key_cipher').notNull(),
  created_at: bigint('created_at', { mode: 'number' }).notNull(),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  deleted_at: bigint('deleted_at', { mode: 'number' }),
})

// Per-account (deployment-wide) settings, moved out of env (mirror of D1 migration 0014's
// `account_settings`). `config` is non-secret tuning JSON; `secrets_cipher` is ONE sealed
// blob grouping every integration credential (domain tag 'cat-factory:account-settings');
// `summary` is non-secret presence JSON. A missing row means all defaults.
export const accountSettings = pgTable('account_settings', {
  account_id: text('account_id').primaryKey(),
  config: text('config').notNull(),
  secrets_cipher: text('secrets_cipher'),
  summary: text('summary').notNull().default('{}'),
  created_at: bigint('created_at', { mode: 'number' }).notNull(),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
})

// Email invitations into an org account. Only the token's hash is stored.
export const accountInvitations = pgTable(
  'account_invitations',
  {
    id: text('id').primaryKey(),
    account_id: text('account_id').notNull(),
    email: text('email').notNull(),
    roles: text('roles').notNull().default('developer'),
    token_hash: text('token_hash').notNull(),
    invited_by: text('invited_by').notNull(),
    status: text('status').notNull().default('pending'),
    expires_at: bigint('expires_at', { mode: 'number' }).notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('idx_account_invitations_account').on(t.account_id),
    uniqueIndex('idx_account_invitations_token').on(t.token_hash),
  ],
)

// Password-reset tokens ("forgot my password"). Only the SHA-256 token hash is stored;
// single-use (status flips to 'used') and expiring. Mirrors the D1 table.
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull(),
    token_hash: text('token_hash').notNull(),
    status: text('status').notNull().default('pending'),
    expires_at: bigint('expires_at', { mode: 'number' }).notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('idx_password_reset_tokens_token').on(t.token_hash),
    index('idx_password_reset_tokens_user').on(t.user_id, t.status),
    // `deleteExpired` sweeps on `expires_at < ?`; index it like every other TTL column
    // (idx_environments_expiry / idx_personal_subs_expiry) so the sweep isn't a full scan.
    index('idx_password_reset_tokens_expiry').on(t.expires_at),
  ],
)

// The durable auth-attempt ledger behind the password-endpoint throttle (SEC-4): one row
// per attempt, counted per bucket key AND per client IP, pruned aggressively (rows are
// junk minutes after the window closes). Mirrors the D1 table (0078_auth_attempts.sql).
export const authAttempts = pgTable(
  'auth_attempts',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull(),
    ip: text('ip').notNull(),
    at: bigint('at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('idx_auth_attempts_key').on(t.key, t.at),
    index('idx_auth_attempts_ip').on(t.ip, t.at),
    // `deleteOlderThan` sweeps on `at < ?`; same TTL-index convention as the tables above.
    index('idx_auth_attempts_at').on(t.at),
  ],
)

// The machine-node roster + revocation tombstones (SEC-5): one row per nodeId a mothership
// minted a machine token for. `revoked_at` is a tombstone every `/internal/*` machine gate
// consults; never cleared. Mirrors the D1 table (0077_machine_nodes.sql).
export const machineNodes = pgTable(
  'machine_nodes',
  {
    node_id: text('node_id').primaryKey(),
    user_id: text('user_id').notNull(),
    // JSON array of the most recent mint's account scope.
    account_ids: text('account_ids').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    last_minted_at: bigint('last_minted_at', { mode: 'number' }).notNull(),
    expires_at: bigint('expires_at', { mode: 'number' }).notNull(),
    revoked_at: bigint('revoked_at', { mode: 'number' }),
    revoked_by: text('revoked_by'),
  },
  (t) => [
    index('idx_machine_nodes_user').on(t.user_id),
    // `deleteExpired` sweeps on `expires_at < ?`; same TTL-index convention as above.
    index('idx_machine_nodes_expiry').on(t.expires_at),
  ],
)
