import type { CloudProvider, InstanceSize, StepSubtasks } from '../domain/types.js'
import type { LlmToolSpan } from './llm-trace-sink.js'

// Port for "where a repo-operating coding job actually runs". The
// ContainerAgentExecutor dispatches each job and polls it through this transport
// rather than talking to a concrete backend, so the same executor drives either:
//   - CloudflareContainerTransport — a per-run Cloudflare Container (the default)
//   - RunnerPoolTransport          — an org's self-hosted runner pool (BYO infra)
//
// A job is addressed by a {@link RunnerJobRef} that names TWO distinct things:
//   - `runId`  — the run (execution) the job belongs to. On backends that share one
//                container across a run (Cloudflare, local Docker) this addresses
//                that per-run container, and `release(runId)` reclaims it.
//   - `jobId`  — the job itself, UNIQUE WITHIN THE RUN. A run executes a SEQUENCE of
//                jobs (one per pipeline step: spec-writer, architect, coder, …), all
//                in the one per-run container, so each needs its own id — the harness
//                keys its per-kind job registries by it. Conflating the two (keying a
//                job by the bare run id) makes sibling steps collide: a poll for one
//                step reads back another step's finished result (the bug where an
//                `architect` /explore poll returned the `spec-writer`'s /spec doc,
//                since both were keyed by the execution id).
//
// Splitting them keeps the run-scoped container reclaim intact while giving every
// step its own job identity. A single-job flow (a repo bootstrap, a repo scan) simply
// uses the same value for both — its run IS its one job.

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
  /** An `on-call` job's release-regression assessment (the `/on-call` endpoint's product). */
  onCallAssessment?: unknown
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
 * Which harness agent a dispatch targets (a coding run, a blueprint run, a
 * read-only repo exploration, a repo-bootstrap run, a CI fix, a merge-conflict
 * resolution, or a merge assessment). All are dispatched + polled identically
 * through this transport; `kind` travels in the job body to the harness's single
 * `POST /jobs` endpoint, which reads it to pick the right agent. The Cloudflare
 * backend serves all of them, and so does a self-hosted pool: it runs the same
 * executor-harness image, and runtime parity is the default (the "keep the runtimes
 * symmetric" guideline), so a pool serves every kind with no opt-in allow-list — a
 * new harness kind reaches it automatically, never silently diverging from Cloudflare.
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
  // Investigate a post-release regression (read the released PR diff + Datadog evidence)
  // and return a JSON assessment; makes no commits, like `merge`.
  | 'on-call'
  // Run the project's tests (against an ephemeral env or local docker-compose infra)
  // and return a structured report; makes no commits, like `merge`.
  | 'test'
  // Apply fixes from a Tester's report to the PR branch and push them back (no new
  // PR), like `ci-fix`.
  | 'fix-tests'

/**
 * Optional, transport-level provisioning hints resolved per-service at dispatch.
 * A self-hosted pool forwards `instanceTypeId` (and `provider`) so it can provision
 * the right size on its own cloud; the local Docker backend maps `instanceSize` to
 * container resource limits. The Cloudflare backend ignores these — its Container
 * instance type is fixed per class by `wrangler.toml` (no per-dispatch sizing).
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
  /**
   * Tool spans the harness buffered SINCE THE LAST POLL (drain-on-read): the executor
   * forwards them to the optional trace sink as child spans under the run trace. Empty/
   * absent on most polls. Best-effort observability — never affects the job lifecycle.
   */
  spans?: LlmToolSpan[]
}

/**
 * Addresses one runner job: the run (execution) it belongs to plus the job's own id.
 * See the file header for why the two are distinct — `runId` scopes the per-run
 * container, `jobId` identifies the step's job uniquely within that run.
 */
export interface RunnerJobRef {
  /** The run (execution) the job belongs to; addresses the per-run container. */
  runId: string
  /** The job's own id, unique within the run (one per pipeline step). */
  jobId: string
}

export interface RunnerTransport {
  /**
   * Start the job `ref.jobId` (in run `ref.runId`) with the harness job `spec`, or
   * re-attach to one already running for that ref. Must be idempotent per ref so a
   * replayed dispatch never starts a duplicate. `kind` selects which harness agent
   * runs (`run` by default, `blueprint` for a Blueprinter job, `bootstrap` for a
   * repo-bootstrap job, …) and is carried in the job body; all are polled identically
   * via {@link poll}.
   */
  dispatch(
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind?: RunnerDispatchKind,
    options?: RunnerDispatchOptions,
  ): Promise<void>
  /** Poll the job's current state. */
  poll(ref: RunnerJobRef): Promise<RunnerJobView>
  /**
   * Optionally reclaim a run's runner resources: the per-run container on backends
   * that share one across the run (Cloudflare, local Docker), and any of the run's
   * still-running jobs on a per-job backend (a self-hosted pool cancels `ref.jobId`).
   * Best-effort and idempotent — releasing an already-gone run/job is a no-op.
   */
  release?(ref: RunnerJobRef): Promise<void>
}
