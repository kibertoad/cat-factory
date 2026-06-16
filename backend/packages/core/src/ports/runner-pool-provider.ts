import type { RunnerPoolManifest } from '../domain/types'
import type { SecretResolver } from './environment-provider'
import type { RunnerJobView } from './runner-transport'

// Port for a self-hosted runner-pool provider: the thing that actually calls an
// org's pool scheduler API to dispatch/poll/release coding jobs. The worker
// supplies a single generic `fetch`-based adapter that *interprets a manifest*,
// so one stateless instance serves every workspace. Credentials are passed per
// call (resolved from the workspace's decrypted secret bundle) so the core never
// holds raw secrets at rest — mirroring the EnvironmentProvider.

export interface RunnerDispatchRequest {
  manifest: RunnerPoolManifest
  /** The cat-factory job id (execution id) the pool is keyed on. */
  jobId: string
  /** The harness job spec; available to templates as `{{input.job}}` (JSON). */
  spec: Record<string, unknown>
  resolveSecret: SecretResolver
}

export interface RunnerPollRequest {
  manifest: RunnerPoolManifest
  jobId: string
  resolveSecret: SecretResolver
}

export interface RunnerPoolProvider {
  /** Start (or re-attach to) the job on the pool. Idempotent per `jobId`. */
  dispatch(req: RunnerDispatchRequest): Promise<void>
  /** Read the job's current state, mapped onto the canonical view. */
  poll(req: RunnerPollRequest): Promise<RunnerJobView>
  /** Free the job/runner (only when the manifest declares a `release` template). */
  release(req: RunnerPollRequest): Promise<void>
}
