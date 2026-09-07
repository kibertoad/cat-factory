import type {
  Block,
  BlockRepository,
  EnvironmentHandle,
  EnvironmentProbeAgent,
  EnvironmentProbeHandle,
  EnvironmentProbeReport,
  EnvironmentProbeSurface,
  EnvironmentProbeUpdate,
  EnvironmentTestRunRecord,
  Logger,
  ResolveRunRepoContext,
} from '@cat-factory/kernel'
import {
  coerceEnvironmentProbeReport,
  environmentProbeSurfaceFor,
  reachabilityNote,
} from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// The `probing` stage of an environment self-test: hand the environment the run just provisioned
// to an agent, and read back whether an agent could actually operate the service.
//
// Its own collaborator rather than three more methods on `EnvironmentTestService`, because it is a
// different concern from the lifecycle: the service owns "which stage is this run in and what does
// it own cleaning up", this owns "what does a dry run need in hand, and what did it come back
// with". The service therefore never sees a container, a repo resolution or a model reply: it
// claims, calls one of the three methods here, and writes what it gets back.
//
// Everything this resolves is read AT THE MOMENT OF THE PROBE rather than pinned when the run
// started, and deliberately so: the environment's URL, its access credentials and its proved route
// are all written by the provisioning stage that just finished, so a value pinned at start time
// would be the value from before there was an environment. The one exception is the SURFACE, which
// the run pins at the claim because it addresses a container (see `probeSurface`).
// ---------------------------------------------------------------------------

/** The environment reads the probe stage makes: the live handle, WITH its decrypted access. */
export interface EnvironmentProbeRegistry {
  getHandleWithAccess(workspaceId: string, id: string): Promise<EnvironmentHandle | null>
}

export interface EnvironmentProbeStageDependencies {
  /** Dispatches, polls and reclaims the probe container (a facade implementation). */
  agent: EnvironmentProbeAgent
  blockRepository: Pick<BlockRepository, 'get'>
  environments: EnvironmentProbeRegistry
  /** Resolves the frame's repo identity, so the prober gets a checkout of what is running. */
  resolveRunRepoContext: ResolveRunRepoContext
  logger?: Logger
}

/** What one poll of the probing stage settled on. */
export type EnvironmentProbeOutcome =
  | { state: 'running' }
  /** The agent reported; the report is already coerced, capped and platform-graded. */
  | { state: 'reported'; report: EnvironmentProbeReport }

export class EnvironmentProbeStage {
  constructor(private readonly deps: EnvironmentProbeStageDependencies) {}

  /**
   * Which prober a frame's dry run runs, through the shared rule the SPA's button label reads.
   *
   * Resolved ONCE, at the claim, and PINNED on the run (`probeSurface`): the surface decides which
   * container the job runs in, so every later poll and reclaim must address the one that started
   * rather than re-derive from a frame that may since have been retyped or deleted.
   */
  surfaceFor(frame: Block): EnvironmentProbeSurface {
    return environmentProbeSurfaceFor(frame.type)
  }

  /**
   * Dispatch the dry run for `record`, whose environment is `ready`.
   *
   * Throws when anything it needs is missing, and each throw is the run's terminal error, so the
   * messages name what a human has to fix rather than what this function could not find. The
   * caller has already CLAIMED the probe (see `EnvironmentTestRunRecord.probeSurface`), so a throw
   * here fails the run at the `probing` stage with the environment still up for `fail()` to
   * reclaim.
   */
  async dispatch(
    record: EnvironmentTestRunRecord,
    surface: EnvironmentProbeSurface,
  ): Promise<EnvironmentProbeHandle> {
    const frame = await this.deps.blockRepository.get(record.workspaceId, record.blockId)
    if (!frame) {
      throw new Error('The service frame was deleted while the agent dry run was starting.')
    }
    if (!record.environmentId) {
      throw new Error('The agent dry run has no provisioned environment to probe.')
    }
    const handle = await this.deps.environments.getHandleWithAccess(
      record.workspaceId,
      record.environmentId,
    )
    if (!handle) {
      throw new Error('The provisioned environment could not be read back for the agent dry run.')
    }
    if (!handle.url) {
      throw new Error(
        'The environment provider exposed no URL for this environment, so there is nothing for ' +
          'an agent to drive. Configure the handler to report the environment URL.',
      )
    }
    const bound = await this.deps.resolveRunRepoContext(record.workspaceId, record.blockId)
    if (!bound?.owner || !bound.name) {
      throw new Error(
        'The agent dry run needs the service repository to work out what the service exposes, ' +
          'and no linked repository resolved for this frame.',
      )
    }
    if (!record.branch) {
      throw new Error('The agent dry run has no test branch to check out.')
    }
    // The same projection the engine hands a tester, so the prober and the tester cannot disagree
    // about what the platform proved. Undefined when nothing has dialled it, which the prompt
    // states rather than omits.
    const reachability = reachabilityNote(handle.reachability ?? null)
    return this.deps.agent.start({
      workspaceId: record.workspaceId,
      jobId: record.id,
      blockId: record.blockId,
      surface,
      repo: {
        owner: bound.owner,
        name: bound.name,
        // The THROWAWAY branch, not the default one: it is the tree this environment was built
        // from, so a service whose routes or auth changed on it is described to the prober as it
        // actually runs rather than as `main` describes it.
        branch: record.branch,
        ...(bound.provider ? { provider: bound.provider } : {}),
        ...(bound.serviceDirectory ? { serviceDirectory: bound.serviceDirectory } : {}),
      },
      environment: {
        url: handle.url,
        status: handle.status,
        ...(handle.access ? { access: handle.access } : {}),
        ...(reachability ? { reachability } : {}),
      },
      service: {
        title: frame.title,
        ...(frame.description?.trim() ? { description: frame.description.trim() } : {}),
      },
      initiatedBy: record.initiatedBy,
    })
  }

  /**
   * Poll the dispatched dry run.
   *
   * A `failed` update THROWS rather than being reported as a verdict: an evicted container or a
   * reply carrying no JSON is a diagnostic that never happened, and returning it as a finding
   * would tell an operator their service is inoperable when it is the platform's own step that
   * broke. The run then fails at the `probing` stage with the container's own error, which is the
   * honest reading and the one the sweeper's cleanup already handles.
   */
  async poll(
    record: EnvironmentTestRunRecord,
    surface: EnvironmentProbeSurface,
  ): Promise<EnvironmentProbeOutcome> {
    const update: EnvironmentProbeUpdate = await this.deps.agent.poll({
      workspaceId: record.workspaceId,
      jobId: record.id,
      surface,
    })
    if (update.state === 'running') return { state: 'running' }
    if (update.state === 'failed') {
      throw new Error(update.error)
    }
    const report = coerceEnvironmentProbeReport(update.report, {
      surface,
      ...(update.model ? { model: update.model } : {}),
    })
    this.deps.logger?.info('environment dry run reported', {
      workspaceId: record.workspaceId,
      runId: record.id,
      surface,
      verdict: report.verdict,
      attempted: report.attempted,
      succeeded: report.succeeded,
      authenticatedSucceeded: report.authenticatedSucceeded,
    })
    return { state: 'reported', report }
  }

  /** Reclaim the probe's container. Best-effort by contract; never throws at the caller. */
  async release(record: EnvironmentTestRunRecord, surface: EnvironmentProbeSurface): Promise<void> {
    await this.deps.agent.stop({
      workspaceId: record.workspaceId,
      jobId: record.id,
      surface,
    })
  }
}
