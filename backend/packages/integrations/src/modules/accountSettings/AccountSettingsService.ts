import type { AccountSettingsRepository, Clock, SecretCipher } from '@cat-factory/kernel'
import { ConflictError } from '@cat-factory/kernel'
import type {
  AccountSettingsConfig,
  AccountSettingsSecrets,
  AccountSettingsSummary,
  AccountSettingsView,
  ContentStorageCapability,
  ContentStorageConfig,
  LinearOAuthSecret,
  S3CredentialsSecret,
  SlackOAuthSecret,
  UpdateAccountSettingsInput,
  WebSearchSecret,
} from '@cat-factory/contracts'
import {
  DEFAULT_ACCOUNT_SETTINGS_CONFIG,
  accountSettingsSummary,
  parseAccountSettingsConfig,
  parseAccountSettingsSecrets,
} from '@cat-factory/contracts'
import * as environmentsLogic from '../environments/environments.logic.js'

/** Capability used when a facade doesn't supply one (storage disabled — e.g. in tests). */
const DISABLED_CONTENT_STORAGE_CAPABILITY: ContentStorageCapability = {
  supportedBackends: ['off'],
  defaultBackend: 'off',
}

/** HKDF domain tag separating the grouped account-settings secret blob from other ciphers. */
export const ACCOUNT_SETTINGS_CIPHER_INFO = 'cat-factory:account-settings'

/** How long a resolved account-settings entry is cached before reloading (ms). */
const CACHE_TTL_MS = 30_000

/** A fully-resolved (decrypted) view of an account's settings, for runtime consumers. */
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

export interface AccountSettingsServiceDependencies {
  accountSettingsRepository: AccountSettingsRepository
  /** Seals the grouped secrets blob (domain tag {@link ACCOUNT_SETTINGS_CIPHER_INFO}). */
  secretCipher: SecretCipher
  clock: Clock
  /**
   * Which content-storage backends THIS runtime can serve + its default. Surfaced in the
   * admin view so the UI only offers valid options. Omitted ⇒ storage disabled (tests).
   */
  contentStorageCapability?: ContentStorageCapability
}

/**
 * Owns per-account deployment settings: a non-secret `config` blob + ONE sealed secrets
 * blob (Slack OAuth / web-search / Langfuse). {@link resolve} decrypts + caches (short TTL)
 * for runtime consumers; {@link read}/{@link write} back the admin UI (secrets write-only —
 * never returned). A single instance per facade holds the cache across requests; writes
 * {@link invalidate} it so a change takes effect immediately.
 */
export class AccountSettingsService {
  private readonly repo: AccountSettingsRepository
  private readonly cipher: SecretCipher
  private readonly clock: Clock
  private readonly contentStorageCapability: ContentStorageCapability
  private readonly cache = new Map<string, { value: ResolvedAccountSettings; expiresAt: number }>()

  constructor(deps: AccountSettingsServiceDependencies) {
    this.repo = deps.accountSettingsRepository
    this.cipher = deps.secretCipher
    this.clock = deps.clock
    this.contentStorageCapability =
      deps.contentStorageCapability ?? DISABLED_CONTENT_STORAGE_CAPABILITY
  }

  /** The resolved (decrypted) settings for an account, cache-first. Defaults when no row. */
  async resolve(accountId: string): Promise<ResolvedAccountSettings> {
    const now = this.clock.now()
    const cached = this.cache.get(accountId)
    if (cached && cached.expiresAt > now) return cached.value
    const record = await this.repo.getByAccount(accountId)
    const config = record ? parseConfig(record.config) : DEFAULT_ACCOUNT_SETTINGS_CONFIG
    const secrets = record?.secretsCipher ? await this.openSecrets(record.secretsCipher) : {}
    const value: ResolvedAccountSettings = {
      config,
      ...(secrets.slackOAuth ? { slackOAuth: secrets.slackOAuth } : {}),
      ...(secrets.linearOAuth ? { linearOAuth: secrets.linearOAuth } : {}),
      ...(secrets.webSearch ? { webSearch: secrets.webSearch } : {}),
      ...(config.contentStorage ? { contentStorage: config.contentStorage } : {}),
      ...(secrets.s3 ? { s3Credentials: secrets.s3 } : {}),
    }
    this.cache.set(accountId, { value, expiresAt: now + CACHE_TTL_MS })
    return value
  }

  /** Drop an account's cached settings (after a write, so the change is seen at once). */
  invalidate(accountId: string): void {
    this.cache.delete(accountId)
  }

  /** Admin read: config + non-secret summary + runtime capability; NEVER returns secrets. */
  async read(accountId: string): Promise<AccountSettingsView> {
    const record = await this.repo.getByAccount(accountId)
    if (!record) {
      return {
        config: DEFAULT_ACCOUNT_SETTINGS_CONFIG,
        summary: accountSettingsSummary({}),
        contentStorageCapability: this.contentStorageCapability,
      }
    }
    return {
      config: parseConfig(record.config),
      summary: parseSummary(record.summary),
      contentStorageCapability: this.contentStorageCapability,
    }
  }

  /**
   * Admin write. `config` (when present) fully replaces the non-secret config. Each
   * secrets group: absent ⇒ leave unchanged, `null` ⇒ clear, value ⇒ set. Re-seals the
   * merged blob, refreshes the summary, and invalidates the cache.
   */
  async write(accountId: string, input: UpdateAccountSettingsInput): Promise<AccountSettingsView> {
    const now = this.clock.now()
    const existing = await this.repo.getByAccount(accountId)
    const config = input.config
      ? parseConfig(JSON.stringify(input.config))
      : existing
        ? parseConfig(existing.config)
        : DEFAULT_ACCOUNT_SETTINGS_CONFIG
    // Decrypt the stored blob STRICTLY before re-sealing: if it can't be opened (e.g. the
    // encryption key changed) refuse rather than silently dropping the un-edited group(s) on
    // this partial write. The operator clears + re-enters to reset. (resolve() stays tolerant
    // — a corrupt blob disables features on read, but a write must never destroy secrets.)
    const current = existing?.secretsCipher ? await this.decryptSecrets(existing.secretsCipher) : {}
    const merged: AccountSettingsSecrets = { ...current }
    if (input.secrets) {
      // SSRF: an account-supplied SearXNG URL is fetched server-side, so reject a private/
      // internal/metadata host at the write boundary (it's re-checked on every fetch hop
      // too). Public host over http/https only — matches the web-search upstream guard.
      const searxngUrl = input.secrets.webSearch?.searxngUrl
      if (searxngUrl) {
        environmentsLogic.assertSafeEnvironmentUrl(searxngUrl, 'SearXNG URL', {
          schemes: ['http', 'https'],
          allowHosts: [],
        })
      }
      for (const key of ['slackOAuth', 'linearOAuth', 'webSearch', 's3'] as const) {
        if (!(key in input.secrets)) continue
        const value = input.secrets[key]
        if (value == null) delete merged[key]
        else merged[key] = value as never
      }
    }
    const hasSecrets = Boolean(
      merged.slackOAuth || merged.linearOAuth || merged.webSearch || merged.s3,
    )
    const summary = accountSettingsSummary(merged, config)
    await this.repo.upsert({
      accountId,
      config: JSON.stringify(config),
      secretsCipher: hasSecrets ? await this.cipher.encrypt(JSON.stringify(merged)) : null,
      summary: JSON.stringify(summary),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    this.invalidate(accountId)
    return { config, summary, contentStorageCapability: this.contentStorageCapability }
  }

  /** Decrypt + parse the sealed secrets blob. Throws when it can't be opened/parsed. */
  private async decryptSecrets(sealed: string): Promise<AccountSettingsSecrets> {
    try {
      return parseAccountSettingsSecrets(JSON.parse(await this.cipher.decrypt(sealed)))
    } catch {
      throw new ConflictError(
        'The stored account settings secrets could not be decrypted (the encryption key may ' +
          'have changed). Clear the deployment integrations and re-enter them to reset.',
      )
    }
  }

  /** Tolerant decrypt for the runtime read path: an unopenable blob ⇒ no secrets. */
  private async openSecrets(sealed: string): Promise<AccountSettingsSecrets> {
    try {
      return await this.decryptSecrets(sealed)
    } catch {
      return {}
    }
  }
}

/** Parse + default a stored config blob, tolerating a malformed/empty value. */
function parseConfig(raw: string): AccountSettingsConfig {
  try {
    return parseAccountSettingsConfig(JSON.parse(raw))
  } catch {
    return DEFAULT_ACCOUNT_SETTINGS_CONFIG
  }
}

const CONTENT_STORAGE_BACKENDS = new Set(['off', 'fs', 's3', 'r2', 'db'])

/** Parse the stored non-secret summary, tolerating a malformed/empty/legacy value. */
function parseSummary(raw: string): AccountSettingsSummary {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>
      const cs = (o.contentStorage ?? {}) as Record<string, unknown>
      const backend =
        typeof cs.backend === 'string' && CONTENT_STORAGE_BACKENDS.has(cs.backend)
          ? (cs.backend as AccountSettingsSummary['contentStorage']['backend'])
          : null
      return {
        slackOAuthConfigured: Boolean(o.slackOAuthConfigured),
        linearOAuthConfigured: Boolean(o.linearOAuthConfigured),
        webSearch: o.webSearch === 'brave' || o.webSearch === 'searxng' ? o.webSearch : null,
        contentStorage: {
          backend,
          bucket: typeof cs.bucket === 'string' ? cs.bucket : null,
          basePath: typeof cs.basePath === 'string' ? cs.basePath : null,
          s3CredentialsConfigured: Boolean(cs.s3CredentialsConfigured),
        },
      }
    }
  } catch {
    // fall through
  }
  return accountSettingsSummary({})
}
