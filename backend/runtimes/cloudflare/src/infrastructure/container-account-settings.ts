import type { Clock, GroupCacheHandle, ResolvedAccountSettings } from '@cat-factory/kernel'
import { ACCOUNT_SETTINGS_CIPHER_INFO, AccountSettingsService } from '@cat-factory/integrations'
import type { ContentStorageCapability } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { D1AccountSettingsRepository } from './repositories/D1AccountSettingsRepository'
import { WebCryptoSecretCipher } from './environments/WebCryptoSecretCipher'
import type { Env } from './env'

// The per-account deployment-settings builder, in a LEAF module on purpose.
//
// It lived in `container.ts`, which both `container-shared-services.ts` and (once the artifact
// storage was split out) `container-artifact-storage.ts` had to import it from — while
// `container.ts` imports both of them back. That is an import cycle, and it survived only
// because `buildAccountSettings` is a hoisted function declaration: make it a `const` arrow, or
// let a module-level constant in `container.ts` come to depend on either child, and it becomes a
// TDZ error at isolate start rather than a compile failure. This module imports nothing from
// `container.ts`, so both children (and `container.ts` itself) depend on it one-directionally.

/**
 * Build the per-account deployment-settings service (Slack OAuth + web-search keys,
 * sealed) when the shared encryption key is present. A single instance is shared so its
 * short-TTL cache spans requests; the facade also derives the Slack OAuth resolver +
 * web-search proxy resolution from it.
 */
export function buildAccountSettings(
  env: Env,
  db: D1Database,
  clock: Clock,
  contentStorageCapability?: ContentStorageCapability,
  settingsCache?: GroupCacheHandle<ResolvedAccountSettings>,
): AccountSettingsService | undefined {
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  if (!encryptionKey) return undefined
  return new AccountSettingsService({
    accountSettingsRepository: new D1AccountSettingsRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: encryptionKey,
      info: ACCOUNT_SETTINGS_CIPHER_INFO,
    }),
    clock,
    ...(contentStorageCapability ? { contentStorageCapability } : {}),
    ...(settingsCache ? { settingsCache } : {}),
  })
}
