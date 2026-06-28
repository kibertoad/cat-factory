import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Per-account (deployment-wide) integration settings, moved out of env vars into a
// single DB row per account, gated behind account-admin. ONE sealed secrets blob groups
// every integration credential (Slack OAuth app, web-search keys, Langfuse keys). A
// (currently empty) non-secret `config` object is kept for forward-compatible tuning.
// Secrets are write-only — `GET` returns only the derived `summary`. DB is the source of
// truth (no env fallback). An integration is "on" for an account when its creds exist.
// ---------------------------------------------------------------------------

// ---- Content (binary-artifact) storage -------------------------------------

/**
 * Where an account's binary artifacts (UI screenshots + reference designs) are stored.
 * `off` disables storage (the visual-confirmation gate passes through). `fs`/`db` are
 * Node/local only; `r2` is Cloudflare only; `s3` works on every runtime. Which of these
 * a runtime actually supports is surfaced to the UI via {@link contentStorageCapabilitySchema}.
 */
export const contentStorageBackendSchema = v.picklist(['off', 'fs', 's3', 'r2', 'db'])
export type ContentStorageBackend = v.InferOutput<typeof contentStorageBackendSchema>

/** Non-secret S3 connection settings (the access keys live in the sealed secrets blob). */
export const contentStorageS3ConfigSchema = v.object({
  region: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  bucket: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(255)),
  /** Optional key prefix, e.g. `artifacts/`. */
  prefix: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(255))),
  /** Optional custom endpoint (S3-compatible stores: MinIO, R2-over-S3, etc.). */
  endpoint: v.optional(v.pipe(v.string(), v.trim(), v.url(), v.maxLength(255))),
  /** Force path-style addressing (needed by most S3-compatible stores). */
  forcePathStyle: v.optional(v.boolean()),
})
export type ContentStorageS3Config = v.InferOutput<typeof contentStorageS3ConfigSchema>

/** Filesystem (Node/local) settings — just the base directory (defaults to `.file-storage`). */
export const contentStorageFsConfigSchema = v.object({
  basePath: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(1024))),
})
export type ContentStorageFsConfig = v.InferOutput<typeof contentStorageFsConfigSchema>

/** Non-secret content-storage config: which backend + its non-secret connection settings. */
export const contentStorageConfigSchema = v.object({
  backend: contentStorageBackendSchema,
  fs: v.optional(contentStorageFsConfigSchema),
  s3: v.optional(contentStorageS3ConfigSchema),
})
export type ContentStorageConfig = v.InferOutput<typeof contentStorageConfigSchema>

/**
 * Non-secret per-account config. Holds the content-storage backend selection (the S3 access
 * keys live in the sealed secrets blob). Retained as an object so forward-compatible
 * non-secret tuning can be added without a migration.
 */
export const accountSettingsConfigSchema = v.object({
  contentStorage: v.optional(contentStorageConfigSchema),
})
export type AccountSettingsConfig = v.InferOutput<typeof accountSettingsConfigSchema>

/** Built-in config used when an account has no row yet. */
export const DEFAULT_ACCOUNT_SETTINGS_CONFIG: AccountSettingsConfig = v.parse(
  accountSettingsConfigSchema,
  {},
)

/** Parse + fully-default a (possibly partial/legacy) stored config blob. */
export function parseAccountSettingsConfig(raw: unknown): AccountSettingsConfig {
  return v.parse(accountSettingsConfigSchema, raw)
}

// ---- Write-only secrets ----------------------------------------------------

/** Slack app OAuth credentials (the deployment's registered Slack app). */
export const slackOAuthSecretSchema = v.object({
  clientId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  clientSecret: v.pipe(v.string(), v.trim(), v.minLength(1)),
  redirectUrl: v.pipe(v.string(), v.trim(), v.url()),
})
export type SlackOAuthSecret = v.InferOutput<typeof slackOAuthSecretSchema>

/**
 * Web-search upstream keys. Brave wins when its key is set, else SearXNG (url +
 * optional key). Both optional so an account can use either.
 */
export const webSearchSecretSchema = v.object({
  braveApiKey: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
  searxngUrl: v.optional(v.pipe(v.string(), v.trim(), v.url())),
  searxngApiKey: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
})
export type WebSearchSecret = v.InferOutput<typeof webSearchSecretSchema>

/** S3 (or S3-compatible) access keys for the content-storage `s3` backend. */
export const s3CredentialsSecretSchema = v.object({
  accessKeyId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(255)),
  secretAccessKey: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(255)),
})
export type S3CredentialsSecret = v.InferOutput<typeof s3CredentialsSecretSchema>

/** The decrypted secrets blob (every group optional). */
export const accountSettingsSecretsSchema = v.object({
  slackOAuth: v.optional(slackOAuthSecretSchema),
  webSearch: v.optional(webSearchSecretSchema),
  s3: v.optional(s3CredentialsSecretSchema),
})
export type AccountSettingsSecrets = v.InferOutput<typeof accountSettingsSecretsSchema>

/** Validate a decrypted secrets blob at the read boundary. */
export function parseAccountSettingsSecrets(raw: unknown): AccountSettingsSecrets {
  return v.parse(accountSettingsSecretsSchema, raw)
}

// ---- Update + view ---------------------------------------------------------

/**
 * Admin write. `config` (when present) fully replaces the non-secret config.
 * Each secrets group: absent ⇒ leave unchanged, `null` ⇒ clear, value ⇒ set.
 */
export const updateAccountSettingsSchema = v.object({
  config: v.optional(accountSettingsConfigSchema),
  secrets: v.optional(
    v.object({
      slackOAuth: v.optional(v.nullable(slackOAuthSecretSchema)),
      webSearch: v.optional(v.nullable(webSearchSecretSchema)),
      s3: v.optional(v.nullable(s3CredentialsSecretSchema)),
    }),
  ),
})
export type UpdateAccountSettingsInput = v.InferOutput<typeof updateAccountSettingsSchema>

/** Non-secret content-storage presence/status for display — NEVER secret values. */
export const contentStorageSummarySchema = v.object({
  /** The explicitly-selected backend, or null when the account uses the runtime default. */
  backend: v.nullable(contentStorageBackendSchema),
  /** Configured S3 bucket (non-secret), when the s3 backend is selected. */
  bucket: v.nullable(v.string()),
  /** Configured filesystem base path (non-secret), when the fs backend is selected. */
  basePath: v.nullable(v.string()),
  /** Whether S3 access keys are stored (the keys themselves are never returned). */
  s3CredentialsConfigured: v.boolean(),
})
export type ContentStorageSummary = v.InferOutput<typeof contentStorageSummarySchema>

/** Non-secret presence/status for display — NEVER secret values. */
export const accountSettingsSummarySchema = v.object({
  slackOAuthConfigured: v.boolean(),
  webSearch: v.nullable(v.picklist(['brave', 'searxng'])),
  contentStorage: contentStorageSummarySchema,
})
export type AccountSettingsSummary = v.InferOutput<typeof accountSettingsSummarySchema>

/**
 * Which content-storage backends THIS runtime can serve + its default when an account has
 * nothing configured. Supplied by the facade so the UI only offers valid options (e.g. `fs`
 * on Node/local, `r2` on Cloudflare) and shows the effective default.
 */
export const contentStorageCapabilitySchema = v.object({
  supportedBackends: v.array(contentStorageBackendSchema),
  defaultBackend: contentStorageBackendSchema,
})
export type ContentStorageCapability = v.InferOutput<typeof contentStorageCapabilitySchema>

/** What `GET /accounts/:id/settings` returns — config + summary + runtime capability, never secrets. */
export const accountSettingsViewSchema = v.object({
  config: accountSettingsConfigSchema,
  summary: accountSettingsSummarySchema,
  contentStorageCapability: contentStorageCapabilitySchema,
})
export type AccountSettingsView = v.InferOutput<typeof accountSettingsViewSchema>

/** Derive the non-secret summary from the secrets blob + the non-secret config. */
export function accountSettingsSummary(
  secrets: AccountSettingsSecrets,
  config?: AccountSettingsConfig,
): AccountSettingsSummary {
  const webSearch = secrets.webSearch?.braveApiKey
    ? ('brave' as const)
    : secrets.webSearch?.searxngUrl
      ? ('searxng' as const)
      : null
  const cs = config?.contentStorage
  return {
    slackOAuthConfigured: Boolean(secrets.slackOAuth),
    webSearch,
    contentStorage: {
      backend: cs?.backend ?? null,
      bucket: cs?.s3?.bucket ?? null,
      basePath: cs?.fs?.basePath ?? null,
      s3CredentialsConfigured: Boolean(secrets.s3),
    },
  }
}
