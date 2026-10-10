import type {
  ConnectionTestResult,
  ProviderConfigField,
  RunnerPoolManifest,
} from '../domain/types.js'
import type { SecretResolver } from './environment-provider.js'
import type { RunnerDispatchAck, RunnerJobStopOutcome, RunnerJobView } from './runner-transport.js'

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

/** Test a pool connection before it is saved (mirrors the environment one). */
export interface RunnerPoolConnectionTestRequest {
  manifest?: RunnerPoolManifest
  config: Record<string, string>
  resolveSecret: SecretResolver
}

export interface RunnerPoolProvider {
  /**
   * Start (or re-attach to) the job on the pool. Idempotent per `jobId`.
   *
   * Returns a {@link RunnerDispatchAck} when the manifest MAPS the harness's acceptance body onto
   * the response (`dispatchCapabilitiesPath`, one line for a pool that proxies `POST /jobs`
   * line); `void` when it does not, which the dispatch site reads as "could not tell". A pool is
   * the deployment shape most likely to lag the backend's image, so mapping it is worth a
   * scheduler author's attention. See `backend/docs/mcp-tool-servers.md`.
   */
  dispatch(req: RunnerDispatchRequest): Promise<RunnerDispatchAck | void>
  /** Read the job's current state, mapped onto the canonical view. */
  poll(req: RunnerPollRequest): Promise<RunnerJobView>
  /**
   * Free the job/runner through the manifest's `release` template, and say whether there WAS one.
   *
   * The outcome is returned rather than swallowed because this doubles as the pool's only way to
   * cancel a job, and a manifest with no `release` template cancels nothing at all. At best it is
   * `requested`: the scheduler accepted the call, and no part of this backend can see far enough
   * into the pool to confirm the runner actually stopped.
   */
  release(req: RunnerPollRequest): Promise<RunnerJobStopOutcome>
  /** Declare the config fields this pool provider expects (see EnvironmentProvider). */
  describeConfig?(manifest?: RunnerPoolManifest): ProviderConfigField[]
  /**
   * The base manifest a native pool adapter is configured through, so the SPA can render
   * the flat `describeConfig` form yet persist a full manifest (mirrors
   * `EnvironmentProvider.describeManifestTemplate`). Absent ⇒ a manifest-authored pool.
   * The shipped generic `HttpRunnerPoolProvider` does not implement it.
   */
  describeManifestTemplate?(): RunnerPoolManifest
  /** Probe the connection without persisting. Optional — absent ⇒ "nothing to test". */
  testConnection?(req: RunnerPoolConnectionTestRequest): Promise<ConnectionTestResult>
}
