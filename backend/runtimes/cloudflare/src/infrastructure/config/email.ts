import type { EmailConfig } from '@cat-factory/server'
import type { Env } from '../env'

export type { EmailConfig }

export function loadEmailConfig(env: Env): EmailConfig {
  // Email is available whenever an encryption key exists — there is no separate opt-in
  // flag. The per-account provider API key is sealed with that key; the provider + key +
  // From address are onboarded per-account in the UI (stored in the DB), NOT read from env.
  const encryptionKey = env.EMAIL_ENCRYPTION_KEY?.trim() || env.ENCRYPTION_KEY?.trim()
  return {
    enabled: !!encryptionKey,
    encryptionKey,
    appBaseUrl: env.APP_BASE_URL?.trim() || env.AUTH_SUCCESS_REDIRECT_URL?.trim() || '',
  }
}
