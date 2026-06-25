import type { ReleaseHealthConfig, IncidentEnrichmentConfig } from '@cat-factory/server'
import type { Env } from '../env'

export type { ReleaseHealthConfig, IncidentEnrichmentConfig }

export function loadReleaseHealthConfig(env: Env): ReleaseHealthConfig {
  // Opt-in via the enable flag; the per-workspace provider credentials are sealed with the
  // shared ENCRYPTION_KEY (under an observability-scoped HKDF info). Off → the
  // post-release-health gate is a pass-through.
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  return {
    enabled: env.OBSERVABILITY_ENABLED === 'true' && !!encryptionKey,
    encryptionKey,
  }
}

export function loadIncidentEnrichmentConfig(env: Env): IncidentEnrichmentConfig {
  // Optional, additive: annotate (never re-alert) an incident PagerDuty / incident.io
  // already opened from the same monitors/SLOs. Deployment-level credentials.
  const pdToken = env.PAGERDUTY_API_TOKEN?.trim()
  const pdFrom = env.PAGERDUTY_FROM_EMAIL?.trim()
  const ioKey = env.INCIDENTIO_API_KEY?.trim()
  return {
    ...(pdToken && pdFrom ? { pagerDuty: { apiToken: pdToken, fromEmail: pdFrom } } : {}),
    ...(ioKey ? { incidentIo: { apiKey: ioKey } } : {}),
  }
}
