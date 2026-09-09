import type {
  AgentFailureKind,
  Block,
  BlockRepository,
  EnvironmentHandle,
  EnvironmentProbeAgent,
  EnvironmentProbeDispatchCheck,
  EnvironmentProbeHandle,
  EnvironmentProbeReport,
  EnvironmentProbeSurface,
  EnvironmentProbeUpdate,
  EnvironmentTestRunRecord,
  Logger,
  ResolveRunRepoContext,
  StepSubtasks,
} from '@cat-factory/kernel'
import { isSubscriptionVendor, noopLogger, redactSecrets } from '@cat-factory/kernel'
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
  /**
   * Still working. `subtasks` is the container's own live todo count when it reported one, which
   * the caller persists: `probing` is the only stage of this run that lasts minutes, so it is the
   * only one where writing nothing leaves the SPA unable to tell work from a wedge.
   */
  | { state: 'running'; subtasks?: StepSubtasks }
  /** The agent reported; the report is already coerced, capped, scrubbed and platform-graded. */
  | { state: 'reported'; report: EnvironmentProbeReport }

/**
 * What a BROKEN dry run says, ahead of the container's own message.
 *
 * The run record has ONE error field, so without this a container that vanished and a model that
 * errored read identically to the developer who has to decide whether pressing the button again
 * is worth anything. Not an exhaustive `Record` over the failure vocabulary: only these arrive on
 * this path (the dispatcher maps everything else through `failureKindFromHarnessCause`), and the
 * default is a true statement about every one of the rest rather than a hole.
 */
function probeFailureCause(kind: AgentFailureKind): string {
  switch (kind) {
    case 'evicted':
      return (
        'The dry run container vanished before it reported (an eviction or a crash), so nothing ' +
        'was established about the environment. Re-running gets a fresh container.'
      )
    case 'harness_shutdown':
      return (
        'The dry run container was shut down while the agent was still working, so nothing was ' +
        'established about the environment.'
      )
    case 'timeout':
      return (
        'The dry run passed its watchdog before reporting, so nothing was established about the ' +
        'environment.'
      )
    default:
      return 'The dry-run agent failed before it produced a report.'
  }
}

export class EnvironmentProbeStage {
  /** The injected logger, normalised once so every site can log unconditionally (CLAUDE.md). */
  private readonly log: Logger

  constructor(private readonly deps: EnvironmentProbeStageDependencies) {
    this.log = deps.logger ?? noopLogger
  }

  /**
   * Which prober a frame's dry run would run, through the shared rule the SPA's button label
   * reads. Pure, so ADMISSION can ask it with the frame it has already loaded and no record yet.
   */
  surfaceFor(frame: Block): EnvironmentProbeSurface {
    return environmentProbeSurfaceFor(frame.type)
  }

  /**
   * Whether this deployment can actually run `surface`'s prober for this workspace, asked at
   * admission. Delegated to the agent, which is where the runner backend is known; see the port
   * for why an unknown answers yes.
   */
  async supports(workspaceId: string, surface: EnvironmentProbeSurface): Promise<boolean> {
    return this.deps.agent.supports(workspaceId, surface)
  }

  /**
   * Whether the model this frame's dry run would run on can actually be dispatched, asked at
   * admission beside {@link supports}. Delegated for the same reason: the model, the harness and
   * the credential that opens it are all facade concerns, and this stage is deliberately free of
   * every one of them.
   */
  async checkDispatchable(
    record: Pick<EnvironmentTestRunRecord, 'workspaceId' | 'blockId' | 'initiatedBy'>,
    surface: EnvironmentProbeSurface,
  ): Promise<EnvironmentProbeDispatchCheck> {
    return this.deps.agent.checkDispatchable({
      workspaceId: record.workspaceId,
      blockId: record.blockId,
      surface,
      initiatedBy: record.initiatedBy,
    })
  }

  /**
   * The frame this run is probing, read ONCE per tick, with the prober its type selects.
   *
   * One read rather than one per collaborator: the surface decides which container the job runs
   * in and the title and description go into the prompt, and two reads a moment apart can observe
   * two different frames, so a rename between them puts a service name in the prompt that does not
   * match the surface the claim pinned. The caller PINS the surface on the run at the claim
   * (`probeSurface`) and passes the pinned value back to {@link dispatch}: every later poll and
   * reclaim must address the container that actually started, not one re-derived from a frame that
   * may since have been retyped or deleted.
   */
  async resolveTarget(
    record: EnvironmentTestRunRecord,
  ): Promise<{ frame: Block; surface: EnvironmentProbeSurface }> {
    const frame = await this.deps.blockRepository.get(record.workspaceId, record.blockId)
    if (!frame) {
      throw new Error('The service frame was deleted while the agent dry run was starting.')
    }
    return { frame, surface: this.surfaceFor(frame) }
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
    frame: Block,
  ): Promise<EnvironmentProbeHandle> {
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
      // Read off the frame this tick already loaded, and carried exactly as the engine carries it
      // to a tester step: the dry run's whole claim is that it is told what the tester will be.
      ...(frame.testingContext ? { testingContext: frame.testingContext } : {}),
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
    const update: EnvironmentProbeUpdate = await this.deps.agent.poll(this.handle(record, surface))
    if (update.state === 'running') {
      return update.subtasks
        ? { state: 'running', subtasks: update.subtasks }
        : { state: 'running' }
    }
    if (update.state === 'failed') {
      throw new Error(`${probeFailureCause(update.failureKind)} ${update.error}`)
    }
    const report = coerceEnvironmentProbeReport(update.report, {
      surface,
      ...(update.model ? { model: update.model } : {}),
      // The report is model-authored text on its way to a persisted row and a rendered panel, and
      // the prompt hands the agent the environment's own credential verbatim plus every sealed
      // test secret in its shell. Asking it not to echo them is guidance; this is the boundary.
      // Applied at the COMPOSE site so it runs before the caps, per the untrusted-text rule.
      scrub: (value) => redactSecrets(value) ?? value,
    })
    this.log.info('environment dry run reported', {
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
    await this.deps.agent.stop(this.handle(record, surface))
  }

  /**
   * The dispatched probe's handle, rebuilt from the RECORD rather than remembered from the
   * dispatch: the durable driver polls from a fresh process, so the record is the only thing both
   * sides of a replay share. The SURFACE is passed in rather than re-derived, because the claim on
   * the record addresses a container and a frame edited mid-run would address a different one.
   *
   * The DISPATCH ATTRIBUTION rides along for the same reason the surface does, and it is why the
   * record carries it at all: everything else on this handle is an address, but the model that ran
   * and the token that paid for it are facts about a moment that has passed. Rebuilt from the row,
   * they survive the replay; re-derived, they would be answers about the frame as it is now. Absent
   * until the dispatch is accepted, which the port documents as a state rather than a hole.
   */
  private handle(
    record: EnvironmentTestRunRecord,
    surface: EnvironmentProbeSurface,
  ): EnvironmentProbeHandle {
    return {
      workspaceId: record.workspaceId,
      jobId: record.id,
      surface,
      blockId: record.blockId,
      initiatedBy: record.initiatedBy,
      ...(record.probeModel
        ? {
            dispatch: {
              model: record.probeModel,
              ...(record.probeSubscriptionTokenId
                ? { subscriptionTokenId: record.probeSubscriptionTokenId }
                : {}),
              ...(isSubscriptionVendor(record.probeSubscriptionVendor)
                ? { subscriptionVendor: record.probeSubscriptionVendor }
                : {}),
            },
          }
        : {}),
    }
  }
}
