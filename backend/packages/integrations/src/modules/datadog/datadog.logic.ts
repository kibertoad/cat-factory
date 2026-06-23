import type { ReleaseSignalState } from '@cat-factory/kernel'

// Pure helpers for the Datadog post-release-health integration: site validation
// (anti-SSRF — only real Datadog hosts), base-URL construction, and mapping Datadog's
// monitor/SLO shapes onto the runtime-neutral `ReleaseSignalState`.

/** The domain tag used to seal Datadog credentials at rest (HKDF info). */
export const DATADOG_CIPHER_INFO = 'cat-factory:datadog'

/** Datadog site host suffixes we allow a connection to point at (anti-SSRF). */
const ALLOWED_SITE_SUFFIXES = [
  'datadoghq.com',
  'datadoghq.eu',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'ap1.datadoghq.com',
  'ddog-gov.com',
]

/**
 * Validate a configured Datadog `site` host and return the normalized host (no
 * scheme/path). Throws when it isn't a recognised Datadog host so a misconfiguration
 * can't turn the server into an SSRF vector. Accepts a bare host or a full URL.
 */
export function normalizeDatadogSite(site: string): string {
  const trimmed = site.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase()
  if (!trimmed) throw new DatadogApiError('config', 'Datadog site is empty')
  const ok = ALLOWED_SITE_SUFFIXES.some((s) => trimmed === s || trimmed.endsWith(`.${s}`))
  if (!ok) {
    throw new DatadogApiError('config', `Unrecognised Datadog site host: ${trimmed}`)
  }
  return trimmed
}

/** The API base URL for a (validated) site host. */
export function datadogApiBase(site: string): string {
  return `https://api.${normalizeDatadogSite(site)}`
}

/** Map Datadog's monitor `overall_state` string onto a release signal state. */
export function mapMonitorState(overallState: string | undefined): ReleaseSignalState {
  switch ((overallState ?? '').toLowerCase()) {
    case 'alert':
    case 'alert_recovery':
      return 'alert'
    case 'warn':
    case 'warn_recovery':
      return 'warn'
    case 'ok':
      return 'ok'
    default:
      // 'No Data' | 'Unknown' | 'Ignored' | 'Skipped' | undefined
      return 'no_data'
  }
}

/**
 * Map an SLO's current SLI value vs its target onto a release signal state:
 * below target → `alert` (error budget breached), at/above → `ok`, missing → `no_data`.
 */
export function mapSloState(sliValue: number | null, target: number | null): ReleaseSignalState {
  if (sliValue === null || target === null) return 'no_data'
  return sliValue < target ? 'alert' : 'ok'
}

export class DatadogApiError extends Error {
  constructor(
    readonly endpoint: string,
    readonly detail: string,
  ) {
    super(`Datadog ${endpoint} failed: ${detail}`)
    this.name = 'DatadogApiError'
  }
}
