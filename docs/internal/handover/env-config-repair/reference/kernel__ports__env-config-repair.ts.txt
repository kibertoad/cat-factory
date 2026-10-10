import type {
  AgentFailure,
  AgentFailureKind,
  EnvConfigRepairStatus,
  StepSubtasks,
} from '../domain/types.js'
import type { RepoValidationIssue } from './environment-provider.js'

// ---------------------------------------------------------------------------
// Ports for the environment-provider CONFIG-REPAIR agent (PR #416 increment 2).
//
// The repair is a durable, asynchronous, observable run modelled exactly like a
// "bootstrap repo" run — it never blocks the triggering request:
//   - EnvConfigRepairer       — the side-effecting dispatch/poll/release of the
//     coding container (the server's ContainerEnvConfigRepairer); the analogue of
//     RepoBootstrapper. It only pushes the fix; the engine re-validates.
//   - EnvConfigRepairRunner   — durably drives the poll loop (the worker's
//     EnvConfigRepairWorkflow / Node pg-boss), the analogue of BootstrapRunner.
//   - EnvConfigRepairJobRepository — the `kind='env-config-repair'` rows of the
//     unified `agent_runs` table.
//
// Kept as ports so the core orchestration (EnvConfigRepairService) stays free of
// GitHub/container infrastructure; tests leave the runner unset and poll directly.
// ---------------------------------------------------------------------------

/** One config-repair run, projected locally (a `kind='env-config-repair'` agent_runs row). */
export interface EnvConfigRepairJobRecord {
  id: string
  workspaceId: string
  owner: string
  repo: string
  /** Branch the agent clones from and pushes the fix back onto. */
  branch: string
  status: EnvConfigRepairStatus
  /** Post-repair validation outcome (null until the run reaches a terminal state). */
  ok: boolean | null
  /** Residual validation issues from the post-repair re-validation. */
  issues: RepoValidationIssue[]
  /** Live subtask counts from the repair agent, or null until it reports. */
  subtasks: StepSubtasks | null
  error: string | null
  /** Structured failure diagnostics when `status` is `failed`; null otherwise. */
  failure: AgentFailure | null
  createdAt: number
  updatedAt: number
}

export type EnvConfigRepairJobRecordPatch = Partial<
  Pick<
    EnvConfigRepairJobRecord,
    'status' | 'ok' | 'issues' | 'subtasks' | 'error' | 'failure' | 'updatedAt'
  >
>

export interface EnvConfigRepairJobRepository {
  insert(record: EnvConfigRepairJobRecord): Promise<void>
  update(workspaceId: string, id: string, patch: EnvConfigRepairJobRecordPatch): Promise<void>
  get(workspaceId: string, id: string): Promise<EnvConfigRepairJobRecord | null>
  listByWorkspace(workspaceId: string): Promise<EnvConfigRepairJobRecord[]>
}

/** Inputs for one config-repair dispatch. `jobId` keys both the run row and the container job. */
export interface EnvConfigRepairRequest {
  workspaceId: string
  jobId: string
  owner: string
  repo: string
  /** Branch to clone, repair in place, and push back onto. */
  gitRef: string
  /** The validation issues that triggered the repair (folded into the agent prompt). */
  issues: RepoValidationIssue[]
  /** The bootstrap form inputs, when available (folded into the agent prompt). */
  inputs?: Record<string, string>
}

/** Addresses a dispatched repair job for polling (the container is keyed by job id). */
export interface EnvConfigRepairHandle {
  workspaceId: string
  jobId: string
}

/** A repair job's current state, as the container reports it via the poll. */
export interface EnvConfigRepairUpdate {
  state: 'running' | 'done' | 'failed'
  /** Present while running once the agent has touched its todo list. */
  subtasks?: StepSubtasks
  /** Present when `state === 'failed'`: why the run faulted. */
  error?: string
  /** Present when `state === 'failed'`: classification of the fault. */
  failureKind?: AgentFailureKind
  /** Present when `state === 'failed'`: extended diagnostic detail, if any. */
  detail?: string
}

export interface EnvConfigRepairer {
  /**
   * Pre-flight (GitHub connected, model proxyable, provider supports repair) and
   * dispatch the repair container. Returns once accepted — the work continues in the
   * container, polled via {@link pollRepair}. Throws on a pre-flight/dispatch failure
   * so the run fails fast. Idempotent per job id: a re-dispatch re-attaches.
   */
  startRepair(request: EnvConfigRepairRequest): Promise<EnvConfigRepairHandle>
  /** Poll a dispatched job for progress / its terminal outcome. */
  pollRepair(handle: EnvConfigRepairHandle): Promise<EnvConfigRepairUpdate>
  /**
   * Best-effort: stop and reclaim the per-run container for a job. Safe to call when
   * the container is already gone — implementations swallow the error.
   */
  stopRepair(handle: EnvConfigRepairHandle): Promise<void>
}

export interface EnvConfigRepairRunner {
  /**
   * Begin durably driving the repair job `jobId` for `workspaceId`. Must be
   * idempotent per job id (a duplicate start, or a sweeper re-drive racing a live
   * instance, is a no-op) — the persisted job record is authoritative.
   */
  startRun(workspaceId: string, jobId: string): Promise<void>
  /**
   * Best-effort: tear down the durable driver for `jobId` when the run is being
   * stopped/cancelled. Idempotent — no live instance to terminate is a no-op.
   */
  cancelRun(workspaceId: string, jobId: string): Promise<void>
}

/** The default runner: does nothing (tests drive `pollJob` directly). */
export class NoopEnvConfigRepairRunner implements EnvConfigRepairRunner {
  async startRun(): Promise<void> {}
  async cancelRun(): Promise<void> {}
}
