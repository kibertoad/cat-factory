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
    system: loadSystemEmailSender(env),
  }
}

/**
 * The deployment-level system sender for auth emails (password reset), read entirely
 * from env. Present only when the provider, From address, and API key are all set.
 */
function loadSystemEmailSender(env: Env): EmailConfig['system'] {
  const provider = env.EMAIL_SYSTEM_PROVIDER?.trim()
  const from = env.EMAIL_SYSTEM_FROM?.trim()
  const apiKey = env.EMAIL_SYSTEM_API_KEY?.trim()
  if ((provider === 'sendgrid' || provider === 'resend') && from && apiKey) {
    return { provider, from, apiKey }
  }
  return undefined
}
