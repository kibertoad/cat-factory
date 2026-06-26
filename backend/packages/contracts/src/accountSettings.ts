import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Per-account (deployment-wide) integration settings, moved out of env vars into a
// single DB row per account, gated behind account-admin. ONE sealed secrets blob groups
// every integration credential (Slack OAuth app, web-search keys, Langfuse keys). A
// (currently empty) non-secret `config` object is kept for forward-compatible tuning.
// Secrets are write-only — `GET` returns only the derived `summary`. DB is the source of
// truth (no env fallback). An integration is "on" for an account when its creds exist.
// ---------------------------------------------------------------------------

/**
 * Non-secret per-account config. Empty today (the integration credentials live in the
 * sealed secrets blob; an integration is enabled by having its creds set). Retained as
 * an object so forward-compatible non-secret tuning can be added without a migration.
 */
export const accountSettingsConfigSchema = v.object({})
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

/** The decrypted secrets blob (every group optional). */
export const accountSettingsSecretsSchema = v.object({
  slackOAuth: v.optional(slackOAuthSecretSchema),
  webSearch: v.optional(webSearchSecretSchema),
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
    }),
  ),
})
export type UpdateAccountSettingsInput = v.InferOutput<typeof updateAccountSettingsSchema>

/** Non-secret presence/status for display — NEVER secret values. */
export const accountSettingsSummarySchema = v.object({
  slackOAuthConfigured: v.boolean(),
  webSearch: v.nullable(v.picklist(['brave', 'searxng'])),
})
export type AccountSettingsSummary = v.InferOutput<typeof accountSettingsSummarySchema>

/** What `GET /accounts/:id/settings` returns — config + summary, never secrets. */
export const accountSettingsViewSchema = v.object({
  config: accountSettingsConfigSchema,
  summary: accountSettingsSummarySchema,
})
export type AccountSettingsView = v.InferOutput<typeof accountSettingsViewSchema>

/** Derive the non-secret summary from the secrets blob. */
export function accountSettingsSummary(secrets: AccountSettingsSecrets): AccountSettingsSummary {
  const webSearch = secrets.webSearch?.braveApiKey
    ? ('brave' as const)
    : secrets.webSearch?.searxngUrl
      ? ('searxng' as const)
      : null
  return {
    slackOAuthConfigured: Boolean(secrets.slackOAuth),
    webSearch,
  }
}
