import type { BootstrapFailureKind, StepSubtasks } from '../domain/types.js'

// RepoBootstrapper port: performs the side-effecting half of a "bootstrap repo"
// run: pre-flight the pre-created target repo, then run a bootstrapper agent in a
// per-run sandbox container that clones the reference architecture (or scaffolds
// from scratch), adapts it per the instructions, and publishes the result the way
// the run's `delivery` says (a force-pushed initial commit, or a work branch and a
// pull request).
//
// The run is driven asynchronously, mirroring the implementation executor: the
// service `startBootstrap`s (dispatches the container, returning once accepted)
// and then `pollBootstrap`s for live subtask progress until a terminal outcome.
// A durable driver (the worker's BootstrapWorkflow) carries the long-running poll
// loop so progress survives the request and is pushed to the board. Kept as a
// port so the core orchestration (BootstrapService) stays free of GitHub/container
// infrastructure; the worker supplies a ContainerRepoBootstrapper, tests a fake.

/**
 * Bootstrap into a subdirectory of an EXISTING monorepo instead of into a new repository.
 *
 * Present ⇒ the dispatch is a different shape end to end, and deliberately so: the run clones
 * the monorepo (writable) with the reference template beside it as a READ-ONLY sibling and works
 * inside `directory`. It never force-pushes and never resets history under either delivery: the
 * target holds other people's services, so the new-repo flow's "reinitialise and force-push" is
 * not merely wrong here, it is destructive.
 *
 * How the work LEAVES the container is {@link BootstrapRepoRequest.delivery}'s question, not
 * this one's: the same subdirectory is written either way.
 */
export interface MonorepoBootstrapLeg {
  /** The monorepo's numeric VCS id (already in the workspace's repo projection). */
  repoGithubId: number
  /** Owner of the monorepo. */
  owner: string
  /** Name of the monorepo. */
  name: string
  /** The new service's subdirectory, relative to the repo root. */
  directory: string
}

/**
 * How a dispatched run publishes what it wrote, resolved by the orchestration from the run's
 * `delivery` and handed over already decided.
 *
 * A discriminated union rather than an enum plus two optional fields, because `branch` and `pr`
 * are meaningless without each other: a request carrying a branch and no PR would push a work
 * branch nobody ever looks at, which is the one outcome neither toggle position asks for.
 */
export type BootstrapDeliveryPlan =
  | {
      mode: 'pull_request'
      /** The work branch to create off the target's default branch and push. */
      branch: string
      /** Title + fallback body for the pull request the run opens. */
      pr: { title: string; body: string }
    }
  | {
      /**
       * Commit onto the target's default branch. A NEW repository takes the work as its single
       * force-pushed initial commit; a monorepo takes it as ordinary commits on the shared
       * branch, published as the agent goes (the harness checkpoints committed work to whatever
       * branch it is pushing), so a run that faults leaves what it had written behind.
       */
      mode: 'direct_push'
    }

export interface BootstrapRepoRequest {
  /** Workspace the run belongs to (resolves the GitHub installation to use). */
  workspaceId: string
  /** Id of the bootstrap job this run records into. */
  jobId: string
  /**
   * The id the container job is dispatched and polled under (the run's `driveId`). Equal to
   * `jobId` on a single-drive run; a monorepo run's apply phase carries its own, because its
   * survey drive already used the run's id and neither the container inventory nor the durable
   * driver can reuse a key that has been through a terminal state.
   */
  containerJobId: string
  /** The base repository to clone from, or undefined to scaffold from scratch. */
  referenceRepo?: { owner: string; name: string }
  /** The repository to create and bootstrap into (a new-repo run only). */
  target: { name: string; description: string; private: boolean }
  /** Set for a monorepo run: which repository the service lands in, and where inside it. */
  monorepo?: MonorepoBootstrapLeg
  /** How the run publishes its work; resolved by the caller, never re-decided here. */
  delivery: BootstrapDeliveryPlan
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

/**
 * Addresses a dispatched bootstrap job for polling.
 *
 * Two ids, because they diverge on a monorepo run: `jobId` addresses the RUN (the stored row the
 * poll reads its target from), `containerJobId` addresses the dispatched container. Passing one
 * for both is how an apply-phase poll would silently attach to the survey drive's key.
 */
export interface BootstrapJobHandle {
  workspaceId: string
  jobId: string
  /** The dispatched container's job id (the run's `driveId`); equal to `jobId` for a plain run. */
  containerJobId: string
}

/** A bootstrap job's current state, as the container reports it via the poll. */
export interface BootstrapJobUpdate {
  state: 'running' | 'done' | 'failed'
  /** Present while running once the agent has touched its todo list. */
  subtasks?: StepSubtasks
  /** Present when `state === 'done'`: where the bootstrapped repo landed. */
  outcome?: BootstrapRepoOutcome
  /**
   * Present when `state === 'done'` on a `pull_request` run: the pull request the agent opened.
   * That run's deliverable IS the pull request, so its absence on a completed run is a failure to
   * report rather than a field to leave null (see `pollBootstrapJob`). A `direct_push` run never
   * carries one.
   */
  prUrl?: string
  /** Present when `state === 'failed'`: why the run faulted. */
  error?: string
  /** Present when `state === 'failed'`: classification of the fault. */
  failureKind?: BootstrapFailureKind
  /** Present when `state === 'failed'`: extended diagnostic detail, if any. */
  detail?: string
}

/** A monorepo the workspace projects, resolved as a bootstrap target. */
export interface MonorepoTargetRepo {
  owner: string
  name: string
  /** The installation the repo is reached through. */
  installationId: number
  /** The repo's default branch, or null when the provider reported none. */
  defaultBranch: string | null
}

export interface RepoBootstrapper {
  /**
   * Whether the workspace is connected to GitHub (an active App installation
   * exists). Checked before a run starts so an unconnected workspace fails fast
   * with a clear error instead of recording a job that immediately fails.
   */
  isWorkspaceConnected(workspaceId: string): Promise<boolean>
  /**
   * Resolve a repository the WORKSPACE projects as a monorepo bootstrap target. Returns null when
   * the workspace projects no such repo, which is what scopes the feature: without it, naming a
   * numeric id would be a way to open a pull request against any repository the deployment's
   * credential happens to reach.
   *
   * READ-ONLY, and separate from {@link markRepoAsMonorepo} for that reason. The two are one
   * DECISION but not one moment: the caller still has refusals to raise between them (a directory
   * that already holds somebody's service, a path that escapes the repository), and a flag written
   * before those would survive the refusal. `resolveRepoTarget` hands an agent a service's
   * subdirectory only while the flag is set, so a repo left marked by a rejected request changes
   * the working directory every service already pinned to it is dispatched at.
   *
   * Lives on this port rather than beside the repo projection because the projection reaches the
   * engine only where a VCS connection is configured, and this is exactly the path that needs it:
   * an unconfigured deployment must refuse the whole monorepo flow, not half-resolve it.
   */
  resolveMonorepoTarget(
    workspaceId: string,
    repoGithubId: number,
  ): Promise<MonorepoTargetRepo | null>
  /**
   * Declare that a resolved repo hosts several services, once the request that needed it has
   * survived every pre-flight. Idempotent: a repo already marked is left alone.
   *
   * Pinning a service to a subdirectory IS this declaration, so the mark cannot be skipped: a
   * service pinned inside a repo that is not marked as a monorepo would have its agents dispatched
   * at the repository ROOT, building in the wrong place with nothing to say so. It is the LAST
   * thing the resolution does, never the first.
   */
  markRepoAsMonorepo(workspaceId: string, repoGithubId: number): Promise<void>
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
   * projection and return its identity, so the caller can bind the board service
   * frame's {@link Service} to it (tasks dropped on that frame then resolve to, and
   * are implemented against, the bootstrapped repo). The projection row is attributed
   * to the workspace's GitHub App installation — the repo is created under it, so it is
   * `'app'`-reachable by every workspace member.
   */
  projectBootstrappedRepo(
    workspaceId: string,
    outcome: BootstrapRepoOutcome,
  ): Promise<{ installationId: number; githubId: number }>
}
