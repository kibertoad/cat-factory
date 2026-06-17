import type { RunnerJobState, RunnerPoolManifest } from '@cat-factory/kernel'
import { assertSafeEnvironmentUrl } from '../environments/environments.logic'

// Pure helpers for the self-hosted runner-pool integration. The generic URL
// validation, `{{var}}` interpolation and dot-path extraction live in the
// environments logic module (they are not environment-specific); we reuse them
// from the manifest interpreter. What is runner-specific lives here: collecting a
// manifest's referenced secret keys, validating every URL it will fetch, and
// mapping a scheduler's status string onto the harness job state.

/** Collect every secret key a manifest's auth scheme references. */
export function referencedSecretKeys(manifest: RunnerPoolManifest): string[] {
  const auth = manifest.auth
  switch (auth.type) {
    case 'none':
      return []
    case 'api_key':
    case 'bearer':
      return [auth.secretRef.key]
    case 'basic':
      return [auth.usernameSecretRef.key, auth.passwordSecretRef.key]
    case 'oauth2_client_credentials':
      return [auth.clientIdSecretRef.key, auth.clientSecretSecretRef.key]
    case 'custom_headers':
      return auth.headers.map((h) => h.secretRef.key)
  }
}

/** Validate every URL a manifest will fetch (defence against SSRF). */
export function assertManifestUrlsSafe(manifest: RunnerPoolManifest): void {
  assertSafeEnvironmentUrl(manifest.baseUrl, 'base URL')
  if (manifest.auth.type === 'oauth2_client_credentials') {
    assertSafeEnvironmentUrl(manifest.auth.tokenUrl, 'OAuth token URL')
  }
}

/**
 * Map a scheduler's status string onto the harness job state using the manifest's
 * `statusMap`. Falls back to interpreting the raw value as a state literal
 * (`running`/`done`/`failed`) when it matches one, else `running` — so a poll
 * that can't be classified keeps the driver waiting rather than wrongly failing.
 */
export function mapJobState(
  raw: string | undefined,
  statusMap: { from: string; to: RunnerJobState }[] | undefined,
): RunnerJobState {
  if (raw !== undefined) {
    if (statusMap) {
      const hit = statusMap.find((m) => m.from.toLowerCase() === raw.toLowerCase())
      if (hit) return hit.to
    }
    const lower = raw.toLowerCase()
    if (lower === 'running' || lower === 'done' || lower === 'failed') return lower
  }
  return 'running'
}
