import type { ReleaseSignalState } from '@cat-factory/kernel'
import { VENDOR_DOCS } from '../../docs.js'

// Pure helpers for the Datadog post-release-health integration: site validation
// (anti-SSRF — only real Datadog hosts), base-URL construction, and mapping Datadog's
// monitor/SLO shapes onto the runtime-neutral `ReleaseSignalState`.

/** The domain tag used to seal observability credentials at rest (HKDF info). */
export const OBSERVABILITY_CIPHER_INFO = 'cat-factory:observability'

/**
 * UI-first remedy for a Datadog auth rejection (401/403): the API + Application keys are entered
 * in the cat-factory UI, so the primary fix names that click path — the env vars don't exist for
 * this connection. Returns the remedy sentence for an auth status, else `undefined` (a 5xx or a
 * mapping error is not a credential problem). Appended to the error detail at the throw site so a
 * rejected key surfaces "re-enter your keys" instead of a bare `HTTP 403`.
 */
export function datadogAuthRemedy(status: number): string | undefined {
  if (status !== 401 && status !== 403) return undefined
  return (
    `your Datadog API and Application keys were rejected — re-enter them in Integrations → ` +
    `Observability connection (mint or rotate them at ${VENDOR_DOCS.datadogApiKeys})`
  )
}

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
  const trimmed = site
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase()
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

/**
 * Map Datadog's monitor `overall_state` string onto a release signal state.
 *
 * `attribution` lets the post-release-health gate ignore an alert that PREDATES the
 * release it is watching: a monitor already alerting before `since` (an unrelated /
 * flaky / never-recovered incident) is not attributable to this release, so it is
 * downgraded to `warn` (which does NOT regress the gate) rather than escalating an
 * on-call investigation that blames an innocent PR. When the transition timestamp is
 * unknown (Datadog didn't report `overall_state_modified`) we keep the alert — better
 * to investigate than to silently miss a real regression.
 */
export function mapMonitorState(
  overallState: string | undefined,
  attribution?: { stateModifiedMs?: number; since: number },
): ReleaseSignalState {
  switch ((overallState ?? '').toLowerCase()) {
    case 'alert':
    case 'alert_recovery':
      // A pre-existing alert (state last changed before the release marker) is not this
      // release's regression — don't escalate on it.
      if (
        attribution &&
        attribution.stateModifiedMs !== undefined &&
        attribution.stateModifiedMs < attribution.since
      ) {
        return 'warn'
      }
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
