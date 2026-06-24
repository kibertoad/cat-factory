import type { UrlSafetyPolicy } from '@cat-factory/kernel'
import type { AppConfig } from './types.js'

// Derive the single shared URL/host safety policy from the (per-integration) config.
// The environment-provisioning and runner-pool integrations both fetch operator-supplied
// URLs; their `allowUrlHosts` / `allowHttpUrls` settings are merged into ONE policy so a
// trusted facade can reach an internal platform on a private/VPN host while the strict
// public-https default still applies to everything else. Returns undefined when nothing
// is widened, so callers leave the integrations on their strict built-in default.

export function resolveUrlSafetyPolicy(config: AppConfig): UrlSafetyPolicy | undefined {
  const hosts = new Set<string>()
  for (const h of config.environments.allowUrlHosts ?? []) hosts.add(h)
  for (const h of config.runners.allowUrlHosts ?? []) hosts.add(h)
  const allowHttp = Boolean(config.environments.allowHttpUrls || config.runners.allowHttpUrls)
  if (hosts.size === 0 && !allowHttp) return undefined
  return {
    schemes: allowHttp ? ['https', 'http'] : ['https'],
    allowHosts: [...hosts],
  }
}
