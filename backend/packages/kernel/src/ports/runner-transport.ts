import type { CloudProvider, InstanceSize, StepSubtasks } from '../domain/types.js'

// Port for "where a repo-operating coding job actually runs". The
// ContainerAgentExecutor dispatches each job and polls it through this transport
// rather than talking to a concrete backend, so the same executor drives either:
//   - CloudflareContainerTransport — a per-run Cloudflare Container (the default)
//   - RunnerPoolTransport          — an org's self-hosted runner pool (BYO infra)
// The transport is addressed purely by the cat-factory job id (the execution id),
// which both backends key on: the Cloudflare container is one Durable Object per
// id, and a self-hosted pool is required to route by the same id (so a replayed
// dispatch re-attaches, and poll/release need no extra handle).

/** Live subtask counts a running job reports (from the coding tool's todo list). */
export type RunnerJobProgress = StepSubtasks

/** The structured work product a finished job records. */
export interface RunnerJobResult {
  prUrl?: string
  branch?: string
  summary?: string
  error?: string
  /** A Blueprinter job's decomposition tree (the `/blueprint` endpoint's product). */
  service?: unknown
  /** A spec-writer job's prescriptive specification doc (the `/spec` endpoint's product). */
  spec?: unknown
  /** A bootstrap job's pushed default branch (the `/bootstrap` endpoint's product). */
  defaultBranch?: string
  /** A `merger` job's PR assessment (the `/merge` endpoint's product). */
  assessment?: unknown
  /** A `ci-fixer` job's outcome: whether it pushed a fix to the PR branch. */
  pushed?: boolean
  /**
   * A conflict-resolver job's outcome: whether the PR branch is now mergeable (the
   * `/resolve-conflicts` endpoint's product). `false` means conflicts remain.
   */
  resolved?: boolean
  /** A `tester` job's structured test report (the `/test` endpoint's product). */
  report?: unknown
  /**
   * Token usage the harness lifted from the agent CLI's own event stream. Reported
   * by the subscription harnesses (Claude Code / Codex), whose traffic bypasses the
   * LLM proxy — so this is the only usage signal for them. The dispatch path folds
   * it into the leased subscription token's rolling-window counters (usage-aware
   * rotation) and the telemetry sink. Absent for the proxy-metered Pi harness.
   */
  usage?: { inputTokens: number; outputTokens: number }
}

/**
 * Which harness endpoint a dispatch targets (a coding run, a blueprint run, a
 * read-only repo exploration, a repo-bootstrap run, a CI fix, a merge-conflict
 * resolution, or a merge assessment). All are dispatched + polled identically
 * through this transport; `kind` only selects the harness endpoint (e.g. `/run` |
 * `/blueprint` | `/explore` | `/resolve-conflicts`). The Cloudflare backend serves
 * all of them; a self-hosted pool serves only `run` and rejects the rest until it
 * implements them.
 */
export type RunnerDispatchKind =
  | 'run'
  | 'blueprint'
  | 'spec'
  // Read-only exploration (architect / analysis): clone + explore + return prose;
  // no work branch, no commit, no PR, and an edit-free run is not a failure.
  | 'explore'
  | 'bootstrap'
  | 'ci-fix'
  | 'resolve-conflicts'
  | 'merge'
  // Run the project's tests (against an ephemeral env or local docker-compose infra)
  // and return a structured report; makes no commits, like `merge`.
  | 'test'
  // Apply fixes from a Tester's report to the PR branch and push them back (no new
  // PR), like `ci-fix`.
  | 'fix-tests'

/**
 * Optional, transport-level provisioning hints resolved per-service at dispatch.
 * Cloudflare maps `instanceTypeId` to a Container instance type; a self-hosted pool
 * forwards it (and `provider`) so it can provision the right size on its own cloud.
 */
export interface RunnerDispatchOptions {
  /** Concrete instance-type id for the target (see `resolveInstanceTypeId`). */
  instanceTypeId?: string
  /** The cloud provider the service selected, for a self-provisioning pool. */
  provider?: CloudProvider
  /**
   * The abstract t-shirt size the service selected, forwarded verbatim so a
   * resource-sizing transport (the local Docker/Podman backend) can map it to
   * concrete `--memory` / `--cpus` limits without reverse-engineering a cloud
   * instance-type id.
   */
  instanceSize?: InstanceSize
}

/** A job's current state, as the harness/pool reports it. */
export interface RunnerJobView {
  state: 'running' | 'done' | 'failed'
  /** Present while running once the agent has touched its todo list. */
  progress?: RunnerJobProgress
  result?: RunnerJobResult
  error?: string
}

export interface RunnerTransport {
  /**
   * Start the job `jobId` with the harness job `spec`, or re-attach to one already
   * running for it. Must be idempotent per job id so a replayed dispatch never
   * starts a duplicate. `kind` selects the harness endpoint (`run` by default,
   * `blueprint` for a Blueprinter job, or `bootstrap` for a repo-bootstrap job);
   * all are polled identically via {@link poll}.
   */
  dispatch(
    jobId: string,
    spec: Record<string, unknown>,
    kind?: RunnerDispatchKind,
    options?: RunnerDispatchOptions,
  ): Promise<void>
  /** Poll the job's current state. */
  poll(jobId: string): Promise<RunnerJobView>
  /** Optionally release the job/runner once a terminal state is observed. */
  release?(jobId: string): Promise<void>
}
