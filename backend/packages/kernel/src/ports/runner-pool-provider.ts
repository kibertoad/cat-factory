import type {
  ConnectionTestResult,
  ProviderConfigField,
  RunnerPoolManifest,
} from '../domain/types.js'
import type { SecretResolver } from './environment-provider.js'
import type { RunnerDispatchAck, RunnerJobView } from './runner-transport.js'

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
   * Returns a {@link RunnerDispatchAck} when the SCHEDULER's response carries the harness's own
   * acceptance body (a pool that proxies `POST /jobs` gets the capability handshake for free);
   * `void` when it does not, which the dispatch site reads as "could not tell". A pool is the
   * deployment shape most likely to lag the backend's image, so forwarding that body is worth a
   * scheduler author's attention. See `backend/docs/mcp-tool-servers.md`.
   */
  dispatch(req: RunnerDispatchRequest): Promise<RunnerDispatchAck | void>
  /** Read the job's current state, mapped onto the canonical view. */
  poll(req: RunnerPollRequest): Promise<RunnerJobView>
  /** Free the job/runner (only when the manifest declares a `release` template). */
  release(req: RunnerPollRequest): Promise<void>
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
