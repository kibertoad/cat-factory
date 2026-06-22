import type { EmailConfig } from '@cat-factory/server'
import type { Env } from '../env'

export type { EmailConfig }

export function loadEmailConfig(env: Env): EmailConfig {
  // Opt-in via EMAIL_ENABLED; the per-account provider API key is sealed with the
  // shared ENCRYPTION_KEY. The provider + key + From address are onboarded per-account
  // in the UI (stored in the DB), NOT read from env.
  const encryptionKey = env.EMAIL_ENCRYPTION_KEY?.trim() || env.ENCRYPTION_KEY?.trim()
  return {
    enabled: env.EMAIL_ENABLED === 'true' && !!encryptionKey,
    encryptionKey,
    appBaseUrl: env.APP_BASE_URL?.trim() || env.AUTH_SUCCESS_REDIRECT_URL?.trim() || '',
  }
}
