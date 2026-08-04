import { sql } from 'drizzle-orm'
import { bigint, index, integer, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core'
// The only FK targets in the schema live in `identity.ts`; the two per-USER credential
// tables here reference `users.id`, so it is imported by name (the same edge
// `../schema.ts` carries for the tables that stayed there).
import { users } from './identity.js'

// ---------------------------------------------------------------------------
// The OUTBOUND MODEL-PROVIDER CREDENTIAL tables: everything the deployment presents to a
// model vendor, plus the usage counters that decide WHICH credential a run leases. One cohesive
// group: the pooled subscription tokens behind the Claude Code / Codex harnesses, the
// direct-provider API keys, the per-user personal subscriptions and their per-run activations, the
// per-user locally-run endpoints, the enabled-gateway-model catalog, and the modeled quota-cycle
// windows all four pools accumulate into.
//
// Deliberately NOT here: `public_api_keys`, which points the other way (the credentials
// external systems present to `/api/v1`, stored as a one-way hash because nothing ever
// needs to replay them). It stays in `../schema.ts` beside the rest of the platform's own
// rows; the contrast between the two directions is documented at its definition.
//
// Split out of `../schema.ts` so that module stays inside its size budget, exactly as
// `identity.ts`, `vcs.ts` and `settings.ts` were; it re-exports everything here, so every
// importer (and drizzle-kit, which follows the re-export) still reaches these through
// `db/schema.js`. Columns mirror the Cloudflare D1 tables one-for-one, per the
// runtime-symmetry rule.
// ---------------------------------------------------------------------------

// Provider-subscription token pool (mirror of D1 migration 0035): per-workspace,
// per-vendor subscription credentials (Claude Pro/Max OAuth token, ChatGPT
// auth.json) authenticating the Claude Code / Codex harnesses. The credential is
// stored as an opaque SecretCipher envelope; usage counters drive usage-aware
// rotation. A workspace may hold many tokens per vendor (a pool).
export const providerSubscriptionTokens = pgTable(
  'provider_subscription_tokens',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    vendor: text('vendor').notNull(),
    label: text('label').notNull(),
    token_cipher: text('token_cipher').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    last_used_at: bigint('last_used_at', { mode: 'number' }),
    window_started_at: bigint('window_started_at', { mode: 'number' }),
    input_tokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    output_tokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    request_count: integer('request_count').notNull().default(0),
    // Lifecycle flags (0/1): `enabled` gates leasing, `is_default` pins the preferred token
    // for a (workspace, vendor). Mirror of D1 migration 0058.
    enabled: integer('enabled').notNull().default(1),
    is_default: integer('is_default').notNull().default(0),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [index('idx_provider_subs_pool').on(t.workspace_id, t.vendor, t.deleted_at)],
)

// Subscription quota-cycle counters (mirror of D1 migration 0047): the MODELED
// rolling-window usage behind "how much of a subscription's quota cycle is left"
// (usage-and-quota-tracking, Part B). One row per (scope, scope_id, vendor, window_kind):
// scope 'pooled' → a provider_subscription_tokens id; scope 'user' → a user id. Each
// window accumulates the same tokens but resets on its own cadence (window_started_at is
// the first-use anchor, re-stamped when the window ages out). Never billed.
export const subscriptionQuotaCycles = pgTable(
  'subscription_quota_cycles',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    scope_id: text('scope_id').notNull(),
    vendor: text('vendor').notNull(),
    window_kind: text('window_kind').notNull(),
    window_started_at: bigint('window_started_at', { mode: 'number' }).notNull(),
    input_tokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    output_tokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    request_count: integer('request_count').notNull().default(0),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('idx_subscription_quota_cycles_key').on(
      t.scope,
      t.scope_id,
      t.vendor,
      t.window_kind,
    ),
    index('idx_subscription_quota_cycles_window').on(t.window_started_at),
  ],
)

// Direct-provider API-key pool: UI-onboarded vendor API keys scoped to an
// account, workspace, or user (mirror of D1 migration 0042). The key is stored as
// an opaque SecretCipher envelope — never plaintext.
export const providerApiKeys = pgTable(
  'provider_api_keys',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    scope_id: text('scope_id').notNull(),
    provider: text('provider').notNull(),
    label: text('label').notNull(),
    key_cipher: text('key_cipher').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    last_used_at: bigint('last_used_at', { mode: 'number' }),
    window_started_at: bigint('window_started_at', { mode: 'number' }),
    input_tokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    output_tokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    request_count: integer('request_count').notNull().default(0),
    // Lifecycle flags (0/1): `enabled` gates leasing, `is_default` pins the preferred key
    // for a (scope, scope_id, provider). Mirror of D1 migration 0058.
    enabled: integer('enabled').notNull().default(1),
    is_default: integer('is_default').notNull().default(0),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [index('idx_provider_api_keys_pool').on(t.scope, t.scope_id, t.provider, t.deleted_at)],
)

// Individual-usage subscriptions (Claude): per-USER, never pooled (mirror of D1
// migration 0039). The credential is double-encrypted (password layer inside the
// system layer).
export const personalSubscriptions = pgTable(
  'personal_subscriptions',
  {
    id: text('id').primaryKey(),
    // ON DELETE RESTRICT: can't drop a user that still owns a personal subscription
    // (the orphaned `psub_X -> usr_OLD` row from the incident).
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    vendor: text('vendor').notNull(),
    label: text('label').notNull(),
    token_cipher: text('token_cipher').notNull(),
    expires_at: bigint('expires_at', { mode: 'number' }),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
    last_used_at: bigint('last_used_at', { mode: 'number' }),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('idx_personal_subs_user_vendor')
      .on(t.user_id, t.vendor)
      .where(sql`${t.deleted_at} IS NULL`),
    index('idx_personal_subs_expiry')
      .on(t.expires_at)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
)

// Per-run activations of a personal credential: the raw token re-encrypted with the
// system key only, scoped to one execution with a TTL (mirror of D1 migration 0039).
export const subscriptionActivations = pgTable(
  'subscription_activations',
  {
    id: text('id').primaryKey(),
    execution_id: text('execution_id').notNull(),
    // ON DELETE RESTRICT: a users row can't be removed while it still has a run activation.
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    vendor: text('vendor').notNull(),
    token_cipher: text('token_cipher').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    expires_at: bigint('expires_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('idx_sub_activations_run').on(t.execution_id, t.user_id, t.vendor),
    index('idx_sub_activations_expiry').on(t.expires_at),
  ],
)

// Per-USER locally-run model endpoints (Ollama / LM Studio / llama.cpp / vLLM / custom),
// keyed by (user_id, provider). The optional bearer key is system-key-encrypted in
// `api_key_cipher`; `models` is a JSON array of enabled model ids (mirror of D1
// migration 0002).
export const localModelEndpoints = pgTable(
  'local_model_endpoints',
  {
    user_id: text('user_id').notNull(),
    provider: text('provider').notNull(),
    label: text('label').notNull(),
    base_url: text('base_url').notNull(),
    api_key_cipher: text('api_key_cipher'),
    models: text('models').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.provider] })],
)

// Per-WORKSPACE enabled GATEWAY models (the dynamic catalog subset) — OpenRouter today,
// LiteLLM and others later. `models` is a JSON array of { id, name, contextLength?,
// inputPerMillion, outputPerMillion } — the enabled subset with cached context + price
// (mirror of D1 migration 0006). Keyed by (workspace_id, provider).
export const providerModelCatalog = pgTable(
  'provider_model_catalog',
  {
    workspace_id: text('workspace_id').notNull(),
    provider: text('provider').notNull(),
    models: text('models').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.provider] })],
)
