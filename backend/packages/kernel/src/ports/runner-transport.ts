import type { StepSubtasks } from '../domain/types.js'

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
}

/**
 * Which harness endpoint a dispatch targets (a coding run, a blueprint run, a
 * repo-bootstrap run, a CI fix, a merge-conflict resolution, or a merge
 * assessment). All are dispatched + polled identically through this transport;
 * `kind` only selects the harness endpoint (e.g. `/run` | `/blueprint` |
 * `/resolve-conflicts`). The Cloudflare backend serves all of them; a self-hosted
 * pool serves only `run` and rejects the rest until it implements them.
 */
export type RunnerDispatchKind =
  | 'run'
  | 'blueprint'
  | 'bootstrap'
  | 'ci-fix'
  | 'resolve-conflicts'
  | 'merge'

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
  dispatch(jobId: string, spec: Record<string, unknown>, kind?: RunnerDispatchKind): Promise<void>
  /** Poll the job's current state. */
  poll(jobId: string): Promise<RunnerJobView>
  /** Optionally release the job/runner once a terminal state is observed. */
  release?(jobId: string): Promise<void>
}
