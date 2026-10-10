import type { ServiceCatalogConfig } from '@cat-factory/server'
import type { Env } from '../env'
import { csv } from './utils'

export type { ServiceCatalogConfig }

/**
 * The SERVICE-CATALOG (developer portal) import config, mirroring the Node facade's
 * `loadServiceCatalogConfig`.
 *
 * No enable flag: the integration assembles wherever the shared ENCRYPTION_KEY is set, because
 * the portal credential must be sealable and whether anything is imported is governed by whether a
 * workspace connected a portal. Its URL allow-list is its OWN slice rather than the environment
 * one's, so admitting an internal portal host does not widen the provisioning integration's guard.
 */
export function loadServiceCatalogConfig(env: Env): ServiceCatalogConfig {
  return {
    encryptionKey: env.ENCRYPTION_KEY?.trim(),
    allowUrlHosts: csv(env.SERVICE_CATALOG_ALLOW_URL_HOSTS),
    allowHttpUrls: env.SERVICE_CATALOG_ALLOW_HTTP_URLS === 'true',
  }
}
