// Persistence port for per-account (deployment-wide) settings. Exactly one row per
// account; a missing row means "all defaults". Mirrors across the D1 (Cloudflare)
// and Drizzle/Postgres (Node) facades (runtime parity is mandatory). The non-secret
// `config` and `summary` are JSON text; `secretsCipher` is ONE sealed blob (by the
// facade's SecretCipher) grouping every integration credential — null when no secret
// has been set. Modelled on EmailConnectionRepository.

import type {
  AccountSettingsConfig,
  ContentStorageConfig,
  LinearOAuthSecret,
  S3CredentialsSecret,
  SlackOAuthSecret,
  WebSearchSecret,
} from '../domain/types.js'

export interface AccountSettingsRecord {
  accountId: string
  /** Non-secret tuning JSON (retention, inline-web-search, enable gates). */
  config: string
  /** Sealed JSON of `{ slackOAuth?, webSearch?, langfuse? }`; null when unset. */
  secretsCipher: string | null
  /** Non-secret presence/status JSON for display (never secret values). */
  summary: string
  createdAt: number
  updatedAt: number
}

export interface AccountSettingsRepository {
  /** The account's settings row, or null when none persisted yet (caller uses defaults). */
  getByAccount(accountId: string): Promise<AccountSettingsRecord | null>
  /** Create or replace the account's settings row. */
  upsert(record: AccountSettingsRecord): Promise<void>
  /** All settings rows (used by the deployment-wide retention sweeper). */
  listAll(): Promise<AccountSettingsRecord[]>
}

/**
 * A fully-resolved (decrypted) view of an account's settings, for runtime consumers
 * (the Slack/Linear OAuth resolvers, the web-search proxy, the S3 blob backend). Produced
 * by `AccountSettingsService.resolve` and cached through the {@link AppCaches.accountSettings}
 * slice. Defined here (not in the service) because the caching port names it — a resolved
 * value composed purely of the non-secret config plus the decrypted secret groups.
 */
export interface ResolvedAccountSettings {
  config: AccountSettingsConfig
  slackOAuth?: SlackOAuthSecret
  linearOAuth?: LinearOAuthSecret
  webSearch?: WebSearchSecret
  /** Non-secret content-storage config (backend selection + connection settings). */
  contentStorage?: ContentStorageConfig
  /** Decrypted S3 access keys for the content-storage `s3` backend, when stored. */
  s3Credentials?: S3CredentialsSecret
}
