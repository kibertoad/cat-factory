import type { ReleaseHealthConfig } from '@cat-factory/server'
import type { Env } from '../env'

export type { ReleaseHealthConfig }

export function loadReleaseHealthConfig(env: Env): ReleaseHealthConfig {
  // Opt-in via the enable flag; the per-workspace provider credentials are sealed with the
  // shared ENCRYPTION_KEY (under an observability-scoped HKDF info). Off → the
  // post-release-health gate is a pass-through. Incident-enrichment credentials
  // (PagerDuty / incident.io) moved out of env into a per-workspace sealed row.
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  return {
    enabled: env.OBSERVABILITY_ENABLED === 'true' && !!encryptionKey,
    encryptionKey,
  }
}
