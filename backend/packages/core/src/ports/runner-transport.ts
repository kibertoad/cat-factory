import type { StepSubtasks } from '../domain/types'

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
   * starts a duplicate.
   */
  dispatch(jobId: string, spec: Record<string, unknown>): Promise<void>
  /** Poll the job's current state. */
  poll(jobId: string): Promise<RunnerJobView>
  /** Optionally release the job/runner once a terminal state is observed. */
  release?(jobId: string): Promise<void>
}
