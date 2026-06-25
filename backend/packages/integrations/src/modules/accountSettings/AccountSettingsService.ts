import type { AccountSettingsRepository, Clock, SecretCipher } from '@cat-factory/kernel'
import type {
  AccountSettingsConfig,
  AccountSettingsSecrets,
  AccountSettingsSummary,
  AccountSettingsView,
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

/** HKDF domain tag separating the grouped account-settings secret blob from other ciphers. */
export const ACCOUNT_SETTINGS_CIPHER_INFO = 'cat-factory:account-settings'

/** How long a resolved account-settings entry is cached before reloading (ms). */
const CACHE_TTL_MS = 30_000

/** A fully-resolved (decrypted) view of an account's settings, for runtime consumers. */
export interface ResolvedAccountSettings {
  config: AccountSettingsConfig
  slackOAuth?: SlackOAuthSecret
  webSearch?: WebSearchSecret
}

export interface AccountSettingsServiceDependencies {
  accountSettingsRepository: AccountSettingsRepository
  /** Seals the grouped secrets blob (domain tag {@link ACCOUNT_SETTINGS_CIPHER_INFO}). */
  secretCipher: SecretCipher
  clock: Clock
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
  private readonly cache = new Map<string, { value: ResolvedAccountSettings; expiresAt: number }>()

  constructor(deps: AccountSettingsServiceDependencies) {
    this.repo = deps.accountSettingsRepository
    this.cipher = deps.secretCipher
    this.clock = deps.clock
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
      ...(secrets.webSearch ? { webSearch: secrets.webSearch } : {}),
    }
    this.cache.set(accountId, { value, expiresAt: now + CACHE_TTL_MS })
    return value
  }

  /** Drop an account's cached settings (after a write, so the change is seen at once). */
  invalidate(accountId: string): void {
    this.cache.delete(accountId)
  }

  /** Admin read: config + non-secret summary; NEVER decrypts/returns the secrets. */
  async read(accountId: string): Promise<AccountSettingsView> {
    const record = await this.repo.getByAccount(accountId)
    if (!record) {
      return {
        config: DEFAULT_ACCOUNT_SETTINGS_CONFIG,
        summary: accountSettingsSummary({}),
      }
    }
    return { config: parseConfig(record.config), summary: parseSummary(record.summary) }
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
    const current = existing?.secretsCipher ? await this.openSecrets(existing.secretsCipher) : {}
    const merged: AccountSettingsSecrets = { ...current }
    if (input.secrets) {
      for (const key of ['slackOAuth', 'webSearch'] as const) {
        if (!(key in input.secrets)) continue
        const value = input.secrets[key]
        if (value == null) delete merged[key]
        else merged[key] = value as never
      }
    }
    const hasSecrets = Boolean(merged.slackOAuth || merged.webSearch)
    const summary = accountSettingsSummary(merged)
    await this.repo.upsert({
      accountId,
      config: JSON.stringify(config),
      secretsCipher: hasSecrets ? await this.cipher.encrypt(JSON.stringify(merged)) : null,
      summary: JSON.stringify(summary),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    this.invalidate(accountId)
    return { config, summary }
  }

  private async openSecrets(sealed: string): Promise<AccountSettingsSecrets> {
    try {
      return parseAccountSettingsSecrets(JSON.parse(await this.cipher.decrypt(sealed)))
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

/** Parse the stored non-secret summary, tolerating a malformed/empty value. */
function parseSummary(raw: string): AccountSettingsSummary {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>
      return {
        slackOAuthConfigured: Boolean(o.slackOAuthConfigured),
        webSearch: o.webSearch === 'brave' || o.webSearch === 'searxng' ? o.webSearch : null,
      }
    }
  } catch {
    // fall through
  }
  return accountSettingsSummary({})
}
