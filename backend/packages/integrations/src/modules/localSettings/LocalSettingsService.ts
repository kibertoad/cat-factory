import type { Clock, LocalSettingsRepository } from '@cat-factory/kernel'
import type { LocalSettings, UpdateLocalSettingsInput } from '@cat-factory/contracts'
import { DEFAULT_LOCAL_SETTINGS, parseLocalSettings } from '@cat-factory/contracts'

/** How long a resolved settings entry is cached before reloading (ms). */
const CACHE_TTL_MS = 5_000

export interface LocalSettingsServiceDependencies {
  localSettingsRepository: LocalSettingsRepository
  clock: Clock
  /**
   * Invoked after a successful {@link LocalSettingsService.write} with the new config, so a
   * facade can apply it LIVE (e.g. reconfigure the runner transport's warm pool) without a
   * restart. Optional; failures are swallowed so a live-apply hiccup never fails the write.
   */
  onChange?: (settings: LocalSettings) => void | Promise<void>
}

/**
 * Owns the local-mode operational settings (warm-pool sizing + per-repo checkout reuse),
 * a per-DEPLOYMENT singleton that replaced the old `LOCAL_POOL_*` / `HARNESS_*` env vars.
 * {@link resolve} reads + caches (short TTL) for the runner transport; {@link read} backs
 * the settings panel and {@link write} persists an edit. A missing row ⇒ all defaults
 * (pooling off, harness defaults). There are no secrets, so the read view is the plain
 * config. A single instance per facade holds the cache across requests; a write
 * invalidates it so a change is seen on the next read.
 */
export class LocalSettingsService {
  private readonly repo: LocalSettingsRepository
  private readonly clock: Clock
  private readonly onChange?: (settings: LocalSettings) => void | Promise<void>
  private cache: { value: LocalSettings; expiresAt: number } | undefined

  constructor(deps: LocalSettingsServiceDependencies) {
    this.repo = deps.localSettingsRepository
    this.clock = deps.clock
    this.onChange = deps.onChange
  }

  /** The resolved settings, cache-first. Defaults when no row persisted yet. */
  async resolve(): Promise<LocalSettings> {
    const now = this.clock.now()
    if (this.cache && this.cache.expiresAt > now) return this.cache.value
    const record = await this.repo.get()
    const value = record ? parseConfig(record.config) : DEFAULT_LOCAL_SETTINGS
    this.cache = { value, expiresAt: now + CACHE_TTL_MS }
    return value
  }

  /** Admin read for the settings panel: the current (fully-defaulted) config. */
  async read(): Promise<LocalSettings> {
    const record = await this.repo.get()
    return record ? parseConfig(record.config) : DEFAULT_LOCAL_SETTINGS
  }

  /** Persist a full-replace of the config, then invalidate the cache. */
  async write(input: UpdateLocalSettingsInput): Promise<LocalSettings> {
    const now = this.clock.now()
    const existing = await this.repo.get()
    const config = parseLocalSettings(input)
    await this.repo.upsert({
      config: JSON.stringify(config),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    this.cache = undefined
    // Apply the edit live (best-effort): the runner transport is built once and cached, so
    // without this a pool/checkout change would only take effect on the next restart.
    try {
      await this.onChange?.(config)
    } catch {
      // a live-apply failure must not fail the persisted write
    }
    return config
  }
}

/** Parse + default a stored config blob, tolerating a malformed/empty value. */
function parseConfig(raw: string): LocalSettings {
  try {
    return parseLocalSettings(JSON.parse(raw))
  } catch {
    return DEFAULT_LOCAL_SETTINGS
  }
}
