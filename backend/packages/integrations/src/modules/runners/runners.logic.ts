import type {
  ContainerEvictionKind,
  RunnerJobState,
  RunnerPoolManifest,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import { STRICT_URL_SAFETY_POLICY } from '@cat-factory/kernel'
import { assertSafeEnvironmentUrl } from '../environments/environments.logic.js'

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
export function assertManifestUrlsSafe(
  manifest: RunnerPoolManifest,
  policy: UrlSafetyPolicy = STRICT_URL_SAFETY_POLICY,
): void {
  assertSafeEnvironmentUrl(manifest.baseUrl, 'base URL', policy)
  if (manifest.auth.type === 'oauth2_client_credentials') {
    assertSafeEnvironmentUrl(manifest.auth.tokenUrl, 'OAuth token URL', policy)
  }
}

/**
 * Scheduler status words that mean the RUNNER went away — the pool member was reclaimed
 * out from under a job that was otherwise fine. Distinct from the failure words below
 * because the recovery differs: an eviction re-dispatches onto a FRESH member (the engine's
 * `recoverContainerEviction` budget), while a job-level failure is the job's own verdict and
 * must not be silently retried.
 *
 * Deliberately narrow. Only words that can mean nothing else are listed: `killed`,
 * `terminated` and `cancelled` are NOT here (they routinely mean "an operator stopped this",
 * and resurrecting such a job on a fresh member would be worse than the wedge this fixes),
 * and neither is anything that could name a queue state.
 */
const EVICTION_STATUSES = new Set([
  'evicted',
  'eviction',
  'preempted',
  'preemption',
  'lost',
  'nodelost',
  'node_lost',
  'node-lost',
  'nodefailure',
  'node_failure',
  'oomkilled',
  'oom_killed',
  'oom-killed',
])

/**
 * Scheduler status words that mean the job is OVER and did not succeed. Without these a
 * pool whose scheduler says `error` / `cancelled` reads as `running` and the run burns its
 * whole ~70-minute poll budget before failing `timeout` — a wedge with a misleading cause.
 */
const FAILED_STATUSES = new Set([
  'failed',
  'failure',
  'error',
  'errored',
  'cancelled',
  'canceled',
  'aborted',
  'killed',
  'timeout',
  'timedout',
  'timed_out',
  'timed-out',
  'deadlineexceeded',
  'deadline_exceeded',
  'unschedulable',
])

/** Scheduler status words that mean the job finished successfully. */
const DONE_STATUSES = new Set(['done', 'complete', 'completed', 'succeeded', 'success', 'finished'])

/** A poll's classified outcome: the canonical job state plus, on a loss, the eviction flavour. */
export interface RunnerJobStatusVerdict {
  state: RunnerJobState
  /**
   * Set only when the failure is the RUNNER vanishing rather than the job failing, so the
   * engine engages its eviction recovery (a fresh pool member) instead of terminally failing
   * the run. `crash` — a pool member is ordinary infrastructure, not the flagged, expected
   * churn (`transient`) a facade mints for its own rollouts.
   */
  evicted?: ContainerEvictionKind
}

/**
 * Classify a scheduler's status string into the canonical job state (+ an eviction verdict).
 *
 * Precedence: the manifest's own `statusMap` decides the STATE — an operator saying what their
 * scheduler's words mean always wins — then the built-in vocabularies above cover the words a
 * manifest didn't map. A resolved `failed` is additionally checked against
 * {@link EVICTION_STATUSES} on the RAW word, so a manifest mapping `evicted → failed` still
 * gets eviction recovery rather than a terminal failure.
 *
 * An UNRECOGNISED word still falls back to `running`, keeping the driver waiting: a scheduler
 * vocabulary we don't know is far more likely to be a queue state (`provisioning`, `assigning`)
 * than a death, and wrongly killing a live run is the worse error of the two. Such a run is
 * still bounded by the poll budget, and the manifest can always map the word explicitly.
 */
export function classifyJobStatus(
  raw: string | undefined,
  statusMap: { from: string; to: RunnerJobState }[] | undefined,
): RunnerJobStatusVerdict {
  if (raw === undefined) return { state: 'running' }
  const lower = raw.toLowerCase()
  const mapped = statusMap?.find((m) => m.from.toLowerCase() === lower)?.to
  const state: RunnerJobState =
    mapped ??
    (FAILED_STATUSES.has(lower) || EVICTION_STATUSES.has(lower)
      ? 'failed'
      : DONE_STATUSES.has(lower)
        ? 'done'
        : 'running')
  return state === 'failed' && EVICTION_STATUSES.has(lower)
    ? { state, evicted: 'crash' }
    : { state }
}

/**
 * Non-fatal gaps in a manifest worth telling the operator about at registration. A manifest
 * is valid without these — the pool still runs jobs — but each one silently costs a recovery
 * or cleanup path, which is invisible until an incident.
 */
export function manifestWarnings(manifest: RunnerPoolManifest): string[] {
  const warnings: string[] = []
  if (!manifest.release) {
    warnings.push(
      `Manifest '${manifest.providerId}' defines no release template, so cancelling a run ` +
        `cannot tell the pool to stop its job — an orphaned job keeps its runner until the ` +
        `pool reclaims it on its own.`,
    )
  }
  if (!manifest.response.statusPath) {
    warnings.push(
      `Manifest '${manifest.providerId}' maps no status path, so every poll reads as still ` +
        `running and a job can only end by exhausting the run's poll budget.`,
    )
  }
  return warnings
}
