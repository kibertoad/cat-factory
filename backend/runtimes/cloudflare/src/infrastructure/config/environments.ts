import type { EnvironmentsConfig } from '@cat-factory/server'
import type { Env } from '../env'
import { csv } from './utils'

export type { EnvironmentsConfig }

export function loadEnvironmentsConfig(env: Env): EnvironmentsConfig {
  // Opt-in via the enable flag; credentials are sealed with the shared ENCRYPTION_KEY
  // (under an environments-scoped HKDF info).
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  return {
    enabled: env.ENVIRONMENTS_ENABLED === 'true' && !!encryptionKey,
    encryptionKey,
    // Trusted-adapter escape hatch: permit an in-house env platform on an internal/VPN
    // host (otherwise the strict public-https guard rejects it).
    allowUrlHosts: csv(env.ENVIRONMENTS_ALLOW_URL_HOSTS),
    allowHttpUrls: env.ENVIRONMENTS_ALLOW_HTTP_URLS === 'true',
  }
}
