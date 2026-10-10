import { type EnvironmentsConfig, parseDetectionConventions } from '@cat-factory/server'
import type { Env } from '../env'
import { csv } from './utils'

export type { EnvironmentsConfig }

export function loadEnvironmentsConfig(env: Env): EnvironmentsConfig {
  // The module assembles whenever the shared ENCRYPTION_KEY is set (credentials are
  // sealed with it, under an environments-scoped HKDF info); there is no separate
  // enable flag. The key is already mandatory service-wide (documents/tasks fail config
  // load without it), so on any real deployment the integration is simply always on.
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  const detectionConventions = parseDetectionConventions(env.ENVIRONMENTS_DETECTION_CONVENTIONS)
  return {
    encryptionKey,
    // Trusted-adapter escape hatch: permit an in-house env platform on an internal/VPN
    // host (otherwise the strict public-https guard rejects it).
    allowUrlHosts: csv(env.ENVIRONMENTS_ALLOW_URL_HOSTS),
    allowHttpUrls: env.ENVIRONMENTS_ALLOW_HTTP_URLS === 'true',
    // Additive house-convention extensions to provisioning detection (JSON object).
    ...(detectionConventions ? { detectionConventions } : {}),
  }
}
