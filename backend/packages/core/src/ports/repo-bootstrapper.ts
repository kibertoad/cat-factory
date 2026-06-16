import type { BootstrapFailureKind, StepSubtasks } from '../domain/types'

// RepoBootstrapper port: performs the side-effecting half of a "bootstrap repo"
// run — pre-flight the pre-created target repo, then run a bootstrapper agent in a
// per-run sandbox container that clones the reference architecture (or scaffolds
// from scratch), adapts it per the instructions, and force-pushes the result.
//
// The run is driven asynchronously, mirroring the implementation executor: the
// service `startBootstrap`s (dispatches the container, returning once accepted)
// and then `pollBootstrap`s for live subtask progress until a terminal outcome.
// A durable driver (the worker's BootstrapWorkflow) carries the long-running poll
// loop so progress survives the request and is pushed to the board. Kept as a
// port so the core orchestration (BootstrapService) stays free of GitHub/container
// infrastructure; the worker supplies a ContainerRepoBootstrapper, tests a fake.

export interface BootstrapRepoRequest {
  /** Workspace the run belongs to (resolves the GitHub installation to use). */
  workspaceId: string
  /** Id of the bootstrap job this run records into (also keys the container job). */
  jobId: string
  /** The base repository to clone from, or undefined to scaffold from scratch. */
  referenceRepo?: { owner: string; name: string }
  /** The repository to create and bootstrap into. */
  target: { name: string; description: string; private: boolean }
  /** Effective bootstrapper instructions (reference defaults + per-run extras). */
  instructions: string
}

export interface BootstrapRepoOutcome {
  /** Web URL of the created repository. */
  repoUrl: string
  /** Owner the repo was created under. */
  owner: string
  /** Name of the created repository. */
  name: string
  /** Default branch the bootstrapped contents were pushed to. */
  defaultBranch: string
}

/** Addresses a dispatched bootstrap job for polling (the container is keyed by job id). */
export interface BootstrapJobHandle {
  workspaceId: string
  jobId: string
}

/** A bootstrap job's current state, as the container reports it via the poll. */
export interface BootstrapJobUpdate {
  state: 'running' | 'done' | 'failed'
  /** Present while running once the agent has touched its todo list. */
  subtasks?: StepSubtasks
  /** Present when `state === 'done'`: where the bootstrapped repo landed. */
  outcome?: BootstrapRepoOutcome
  /** Present when `state === 'failed'`: why the run faulted. */
  error?: string
  /** Present when `state === 'failed'`: classification of the fault. */
  failureKind?: BootstrapFailureKind
  /** Present when `state === 'failed'`: extended diagnostic detail, if any. */
  detail?: string
}

export interface RepoBootstrapper {
  /**
   * Whether the workspace is connected to GitHub (an active App installation
   * exists). Checked before a run starts so an unconnected workspace fails fast
   * with a clear error instead of recording a job that immediately fails.
   */
  isWorkspaceConnected(workspaceId: string): Promise<boolean>
  /**
   * Pre-flight the target repo (exists, reachable, empty-or-boilerplate) and
   * dispatch the bootstrap container. Returns once the job is accepted — the work
   * continues in the container, polled via {@link pollBootstrap}. Throws on a
   * pre-flight failure (e.g. the repo has real content) so the run fails fast.
   * Idempotent per job id: a re-dispatch re-attaches rather than duplicating.
   */
  startBootstrap(request: BootstrapRepoRequest): Promise<BootstrapJobHandle>
  /** Poll a dispatched job for progress / its terminal outcome. */
  pollBootstrap(handle: BootstrapJobHandle): Promise<BootstrapJobUpdate>
  /**
   * Best-effort: stop and reclaim the per-run container for a job (e.g. after the
   * run faulted), so a leaked instance doesn't idle until its sleep timer. Safe to
   * call when the container is already gone — implementations swallow the error.
   */
  stopBootstrap(handle: BootstrapJobHandle): Promise<void>
  /**
   * After a successful run: ensure the new repo is present in the local GitHub
   * projection and link it to the board service frame `blockId`, so tasks dropped
   * on that frame resolve to (and are implemented against) the bootstrapped repo.
   */
  linkRepoToBlock(
    workspaceId: string,
    outcome: BootstrapRepoOutcome,
    blockId: string,
  ): Promise<void>
}
