import {
  ConflictError,
  UnavailableError,
  describeError,
  getErrorMessage,
  noopLogger,
  stepJobId,
  type AgentContextRecorder,
  type AgentJobHandle,
  type AgentJobUpdate,
  type AgentRunContext,
  type AgentRunResult,
  type AsyncAgentExecutor,
  type Clock,
  type DelegatedExecutor,
  type DelegatedExecutorDefinition,
  type DelegatedExecutorDeps,
  type DelegatedExecutorRegistry,
  type DelegationHandle,
  type DelegationUpdate,
  type Logger,
  type RunReclaimReport,
  type RunReclaimTarget,
  type TaskRepository,
  type ToolSecretResolver,
} from '@cat-factory/kernel'
import type { AgentKindRegistry } from '@cat-factory/agents'
import { delegatedExecutorFor } from '@cat-factory/agents'
import { composeDelegationBrief, briefRepoProvider } from './brief.js'
import { recordAgentContextSnapshot } from './agentContextRecord.js'
import { resolveDelegationCredentials } from './delegationCredentials.js'
import type { ResolveRepoTarget, ResolveRepoOrigin } from './repoTargeting.js'
import { githubRepoOrigin } from './containerAgentBody.js'

// ---------------------------------------------------------------------------
// The THIRD executor class: a step whose work happens in a system the deployment already runs.
//
// It is deliberately thin, and thinner than the container executor by a long way, because almost
// everything the container path does is about OUR machine: minting a clone token, leasing a
// subscription, resolving a harness, wiring MCP servers, negotiating image capabilities. None of
// that applies to a system that owns its own runner, its own credentials and its own agent. What
// is left is the part that is genuinely ours: compose the brief (the SAME composition the harness
// dispatch uses), resolve the executor's declared credentials for this workspace, hand both over,
// and map what comes back into the engine's vocabulary.
//
// The one rule with teeth is idempotency. Both durable drivers replay, and an executor asked to
// start twice produces two external runs and two pull requests for one task. The engine commits
// the claim before this executor is called; this side upholds the other half by re-attaching on a
// poll rather than re-starting, and by passing the correlation key the executor was asked to make
// its run findable by.
// ---------------------------------------------------------------------------

/** What the facade wires for the delegated path. */
export interface DelegatedAgentExecutorDependencies {
  /** The app-owned registry of the deployment's external executors. */
  delegatedExecutorRegistry: DelegatedExecutorRegistry
  /** The app-owned agent-kind registry: which kinds are delegated, and to which executor. */
  agentKindRegistry: AgentKindRegistry
  /** The run's repo target (the service↔repo projection), the same resolver the container uses. */
  resolveRepoTarget: ResolveRepoTarget
  /** Where the repo is reached: the clone URL plus the VCS provider. Defaults to GitHub. */
  resolveRepoOrigin?: ResolveRepoOrigin
  /**
   * Where the work came from, when it came from a tracker. One read per dispatch off the block's
   * linked issues, never a per-issue loop, and never re-read on a poll.
   */
  taskRepository?: TaskRepository
  /**
   * Resolves an executor's declared credentials for this workspace. Absent ⇒ every executor is
   * called with an empty bag, which is exactly what a deployment that declared none expects and
   * what one that declared some will see as its own system refusing the call.
   */
  resolveToolSecrets?: ToolSecretResolver
  /** Files the dispatch's agent-context snapshot; absent ⇒ nothing is recorded. */
  agentContextObservability?: AgentContextRecorder
  /** The bound deps every registered executor is BUILT over. */
  executorDeps: DelegatedExecutorDeps
  logger: Logger
  clock: Clock
}

/**
 * Runs a `delegated`-surface step on a registered external executor.
 *
 * Async by construction: an external run is polled, never awaited, which is the same shape the
 * container executor has and the reason both durable drivers already know how to drive it.
 */
export class DelegatedAgentExecutor implements AsyncAgentExecutor {
  private readonly log: Logger
  /**
   * Built executors, memoised per id for the life of this instance.
   *
   * A definition's `create` may build a client, and this executor is constructed once per app
   * (per isolate on the Worker), so building per dispatch would discard whatever an executor
   * warmed. Memoising on the INSTANCE rather than a module map is what keeps it out of the
   * module-global trap every registry in this codebase is built to avoid.
   */
  private readonly built = new Map<string, DelegatedExecutor>()

  constructor(private readonly deps: DelegatedAgentExecutorDependencies) {
    this.log = deps.logger.child({ component: 'delegatedAgent' })
  }

  /** Every delegated step is polled: an external run outlives any request of ours. */
  runsAsync(_context: AgentRunContext): boolean {
    return true
  }

  /**
   * A delegated step resolves NO model, and that is the honest answer rather than a gap.
   *
   * The external executor picks its own, through its own credentials, and the platform never sees
   * it. Returning a guess would put a model on the board that nothing ran, and every reader
   * downstream (the run card, the spend rollup, the debug overview) would treat it as the thing
   * that spent the tokens it also cannot see.
   */
  resolveModel(_context: AgentRunContext): Promise<string | undefined> {
    return Promise.resolve(undefined)
  }

  /**
   * Not quota-based. A delegated run spends nothing of OURS: no pooled subscription token is
   * leased and no proxy call is metered, so it is neither quota nor budget.
   */
  isQuotaBased(_context: AgentRunContext): Promise<boolean> {
    return Promise.resolve(false)
  }

  /**
   * Start (or RE-ATTACH to) this step's external work.
   *
   * Idempotent per correlation key, which is what the port asks of every executor and what the
   * engine's claim-before-effect makes possible on this side: the key is derived from the run, the
   * kind and the dispatch epoch, so a replayed dispatch produces the same key and the executor is
   * asked to recognise its own run rather than start another.
   */
  async startJob(context: AgentRunContext): Promise<AgentJobHandle> {
    const { workspaceId, executionId, blockId } = requireIds(context)
    const definition = this.requireDefinition(context.agentKind)
    const executor = this.executorFor(definition)
    const correlationKey = stepJobId(executionId, context.agentKind, context.dispatchEpoch)
    const brief = await this.composeBrief(context, {
      workspaceId,
      executionId,
      blockId,
      correlationKey,
    })
    const jobLog = this.log.child({
      workspaceId,
      executionId,
      jobId: correlationKey,
      agentKind: context.agentKind,
      executor: definition.id,
    })
    const credentials = await resolveDelegationCredentials({
      definition,
      workspaceId,
      blockId,
      resolveToolSecrets: this.deps.resolveToolSecrets,
      logger: jobLog,
    })
    let started
    try {
      started = await executor.start(brief, credentials)
    } catch (error) {
      jobLog.warn('delegated executor refused the dispatch', describeError(error))
      throw new UnavailableError(
        `The "${definition.id}" executor could not start this step: ${getErrorMessage(error)}`,
        'delegated_executor_failed',
        { executor: definition.id },
      )
    }
    if (!started.externalId) {
      // Refused rather than recorded, because a dispatch with no external id can never be polled:
      // the step would park on a job nothing can settle and fail hours later on its poll budget,
      // naming a timeout instead of the contract the executor broke.
      throw new UnavailableError(
        `The "${definition.id}" executor started this step and returned no external id, so the ` +
          'platform has nothing to poll. An executor whose system reports no id at start is ' +
          "expected to recover one by the brief's correlation key before returning.",
        'delegated_executor_failed',
        { executor: definition.id },
      )
    }
    jobLog.info('delegated work started', {
      externalId: started.externalId,
      ...(started.url ? { externalUrl: started.url } : {}),
    })
    // The same snapshot a container dispatch files, from the same allow-list: what the agent was
    // told is auditable through `/api/v1/debug/runs/:runId/agent-context` whoever ran it. The
    // credentials resolved above are deliberately not in scope of the body handed to it.
    await recordAgentContextSnapshot(this.deps.agentContextObservability, jobLog, {
      context,
      body: snapshotBody(brief),
      // There is no model to name: the executor chose one we never saw. Naming the EXECUTOR under
      // a provider of `delegated` says exactly that, where a blank would read as a dispatch that
      // resolved nothing and a borrowed default would name a model that ran nowhere.
      model: `delegated:${definition.id}`,
      workspaceId,
      executionId,
    })
    return {
      jobId: correlationKey,
      runId: executionId,
      workspaceId,
      agentKind: context.agentKind,
      ...(context.initiatedByUserId ? { initiatedByUserId: context.initiatedByUserId } : {}),
      repo: {
        owner: brief.repo.owner,
        name: brief.repo.name,
        baseBranch: brief.branches.base,
        provider: brief.repo.provider,
      },
      delegated: {
        executor: definition.id,
        externalId: started.externalId,
        ...(started.url ? { url: started.url } : {}),
        // What a later poll cannot derive: a handle carries the run, and the work branch is named
        // from the BLOCK. An executor reading back what its own system produced needs it, and
        // guessing puts the wrong pull request on the block.
        branches: brief.branches,
      },
    }
  }

  /**
   * Poll the external work, re-resolving the executor's credentials FIRST.
   *
   * Re-resolved rather than carried on the handle, and that is not a caching miss: a delegated
   * poll can run hours after the dispatch, a GitHub App token lives one hour, and a credential
   * frozen at dispatch would be dead exactly on the long runs this executor class exists for.
   */
  async pollJob(handle: AgentJobHandle): Promise<AgentJobUpdate> {
    const delegated = handle.delegated
    if (!delegated) {
      throw new ConflictError(
        'A delegated poll arrived with no delegation on its handle, so there is nothing to ' +
          'address. The step records which executor it dispatched to; a handle without it was ' +
          'rebuilt from a step that never claimed one.',
        'delegated_executor_unwired',
      )
    }
    const definition = this.requireDefinition(handle.agentKind ?? '', delegated.executor)
    const executor = this.executorFor(definition)
    const jobLog = this.log.child({
      workspaceId: handle.workspaceId,
      executionId: handle.runId,
      jobId: handle.jobId,
      agentKind: handle.agentKind,
      executor: definition.id,
    })
    const target: DelegationHandle = {
      executor: definition.id,
      correlationKey: handle.jobId,
      externalId: delegated.externalId,
      ...(delegated.url ? { url: delegated.url } : {}),
      ...(delegated.branches ? { branches: delegated.branches } : {}),
      workspaceId: handle.workspaceId ?? '',
      runId: handle.runId ?? handle.jobId,
      agentKind: handle.agentKind ?? '',
    }
    const credentials = await resolveDelegationCredentials({
      definition,
      workspaceId: handle.workspaceId ?? '',
      resolveToolSecrets: this.deps.resolveToolSecrets,
      logger: jobLog,
    })
    const update = await executor.poll(target, credentials)
    return toJobUpdate(update, definition)
  }

  /**
   * Stop every delegated unit this run holds, and REPORT what that achieved.
   *
   * The report is the point. An executor that declares no `cancel` leaves its run alive: it will
   * finish, open its pull request and bill its tokens long after the platform recorded this run as
   * stopped, and the person who stopped it is the one who needs to know to go and stop it there.
   * Best-effort throughout (a teardown must never propagate) but never SILENT: a failure to
   * cancel is reported as "not cancelled" with its cause, which is a different fact from a clean
   * stop and renders differently on the step.
   */
  async reclaimRun(target: RunReclaimTarget): Promise<RunReclaimReport | void> {
    const handles = target.delegations ?? []
    if (handles.length === 0) return
    const delegations = await Promise.all(handles.map((handle) => this.cancelOne(handle)))
    return { delegations }
  }

  /**
   * A delegated step cannot be run SYNCHRONOUSLY: `run()` exists for non-durable callers and
   * tests, and an external system that answers in hours is exactly what that shape cannot serve.
   * Refused loudly rather than looped in-process, which would hold a request open for the duration
   * of somebody else's CI.
   */
  run(context: AgentRunContext): Promise<AgentRunResult> {
    return Promise.reject(
      new ConflictError(
        `The \`${context.agentKind}\` step runs on an external executor, which is polled rather ` +
          'than awaited. Drive it through the async path (`startJob` / `pollJob`).',
        'delegated_executor_unwired',
      ),
    )
  }

  private async cancelOne(
    handle: DelegationHandle,
  ): Promise<{ correlationKey: string; cancelled: boolean; note?: string }> {
    const definition = this.deps.delegatedExecutorRegistry.get(handle.executor)
    if (!definition) {
      return {
        correlationKey: handle.correlationKey,
        cancelled: false,
        note: `This deployment no longer registers the "${handle.executor}" executor, so the external work could not be stopped.`,
      }
    }
    const executor = this.executorFor(definition)
    if (!executor.cancel) {
      return {
        correlationKey: handle.correlationKey,
        cancelled: false,
        note: `The "${definition.id}" executor declares no cancel, so the external work was left running.`,
      }
    }
    const jobLog = this.log.child({
      workspaceId: handle.workspaceId,
      executionId: handle.runId,
      jobId: handle.correlationKey,
      executor: definition.id,
    })
    try {
      const credentials = await resolveDelegationCredentials({
        definition,
        workspaceId: handle.workspaceId,
        resolveToolSecrets: this.deps.resolveToolSecrets,
        logger: jobLog,
      })
      await executor.cancel(handle, credentials)
      return { correlationKey: handle.correlationKey, cancelled: true }
    } catch (error) {
      jobLog.warn('delegated cancel failed; the external work may still be running', {
        ...describeError(error),
      })
      return {
        correlationKey: handle.correlationKey,
        cancelled: false,
        note: `Stopping the external work failed (${getErrorMessage(error)}); it may still be running.`,
      }
    }
  }

  /** The registered definition for a kind, refusing the two ways it can be missing. */
  private requireDefinition(
    agentKind: string,
    knownExecutor?: string,
  ): DelegatedExecutorDefinition {
    const id = knownExecutor ?? delegatedExecutorFor(agentKind, this.deps.agentKindRegistry)
    if (!id) {
      throw new ConflictError(
        `The \`${agentKind}\` step was routed to the delegated executor and declares none.`,
        'delegated_executor_unwired',
      )
    }
    const definition = this.deps.delegatedExecutorRegistry.get(id)
    if (!definition) {
      throw new ConflictError(
        `The \`${agentKind}\` step runs on the delegated executor "${id}", which this ` +
          `deployment does not register` +
          (this.deps.delegatedExecutorRegistry.size > 0
            ? ` (registered: ${this.deps.delegatedExecutorRegistry.ids().join(', ')}).`
            : '.'),
        'delegated_executor_unwired',
      )
    }
    return definition
  }

  private executorFor(definition: DelegatedExecutorDefinition): DelegatedExecutor {
    const existing = this.built.get(definition.id)
    if (existing) return existing
    const built = definition.create(this.deps.executorDeps)
    this.built.set(definition.id, built)
    return built
  }

  /** Resolve the repo + branches this dispatch targets, then compose the brief over them. */
  private async composeBrief(
    context: AgentRunContext,
    ids: { workspaceId: string; executionId: string; blockId: string; correlationKey: string },
  ) {
    const repo = await this.deps.resolveRepoTarget(ids.workspaceId, ids.blockId)
    if (!repo) {
      throw new ConflictError(
        `No connected repository found for workspace '${ids.workspaceId}'. A delegated step is ` +
          'still work on a repository: link one to this service before running it.',
        'github_not_connected',
      )
    }
    const origin = (this.deps.resolveRepoOrigin ?? githubRepoOrigin)(repo)
    const trackerRef = await this.resolveTrackerRef(ids.workspaceId, ids.blockId)
    return composeDelegationBrief(context, this.deps.agentKindRegistry, {
      correlationKey: ids.correlationKey,
      workspaceId: ids.workspaceId,
      runId: ids.executionId,
      stepIndex: context.stepIndex ?? 0,
      target: {
        repo: {
          owner: repo.owner,
          name: repo.name,
          cloneUrl: origin.cloneUrl,
          provider: briefRepoProvider(repo.provider ?? origin.provider),
          ...(repo.serviceDirectory ? { directory: repo.serviceDirectory } : {}),
        },
        branches: {
          base: repo.baseBranch,
          // The deterministic per-task branch every step of this run's pipeline shares: the same
          // name the container path resolves, so a delegated producer and a later container fixer
          // work on ONE branch. The platform does not create it: a delegated executor makes its
          // own branch when it pushes, and creating an empty ref here would leave one behind for
          // every run whose external work never landed.
          work: `cat-factory/${ids.blockId}`,
        },
        ...(trackerRef ? { trackerRef } : {}),
      },
    })
  }

  /**
   * Where the work came from, when it came from a tracker: ONE batch read of the block's linked
   * issues, and the first live one.
   *
   * First rather than all, because the brief names the ticket the work is FOR and a block carries
   * one such link by construction (`claimBlockLink` makes "one task per ticket" an invariant). Any
   * further attachments are reference material, and they already reach the agent as context files.
   */
  private async resolveTrackerRef(
    workspaceId: string,
    blockId: string,
  ): Promise<{ provider: string; key: string; url?: string } | undefined> {
    const repository = this.deps.taskRepository
    if (!repository) return undefined
    const linked = await repository.listByBlock(workspaceId, blockId)
    const first = linked[0]
    if (!first) return undefined
    return {
      provider: first.source,
      key: first.externalId,
      ...(first.url ? { url: first.url } : {}),
    }
  }
}

/** The delegated dispatch's ids, refused together so a caller cannot proceed on half of them. */
function requireIds(context: AgentRunContext): {
  workspaceId: string
  executionId: string
  blockId: string
} {
  const { workspaceId, executionId } = context
  const blockId = context.block.id
  if (!workspaceId || !executionId || !blockId) {
    throw new Error('DelegatedAgentExecutor requires workspaceId, executionId and block.id')
  }
  return { workspaceId, executionId, blockId }
}

/**
 * The brief, shaped as the agent-context snapshot's allow-list reads it.
 *
 * It reuses that allow-list rather than adding a second projection, because the rule it enforces
 * (copy the prompts, the fragment bodies and the context files; never a credential) is exactly as
 * binding here. `mode: 'delegated'` is what tells a reader of the snapshot that no container ran.
 */
function snapshotBody(brief: {
  systemPrompt: string
  userPrompt: string
  contextFiles: readonly { path: string; title?: string; url?: string; content: string }[]
  repo: { owner: string; name: string }
  branches: { base: string; work: string }
}): Record<string, unknown> {
  return {
    mode: 'delegated',
    systemPrompt: brief.systemPrompt,
    userPrompt: brief.userPrompt,
    contextFiles: brief.contextFiles,
    repo: { owner: brief.repo.owner, name: brief.repo.name, baseBranch: brief.branches.base },
    branch: brief.branches.work,
  }
}

/**
 * Map an executor's own answer into the engine's poll vocabulary.
 *
 * The two places this is NOT a rename:
 *
 * - `retryable` decides whether a failure is re-driven on the job-failure budget or is terminal.
 *   An executor that says nothing means TERMINAL, because a verdict its own system called final is
 *   not something a second dispatch improves on, and the alternative spends the budget re-running
 *   somebody else's CI to reach the same answer.
 * - `usage` rides straight through, and its ABSENCE is the honest state for an executor that does
 *   not report it. Nothing here invents a zero: a zero would be summed into the run's total and
 *   read as work that cost nothing.
 */
function toJobUpdate(
  update: DelegationUpdate,
  definition: DelegatedExecutorDefinition,
): AgentJobUpdate {
  if (update.state === 'running') {
    return {
      state: 'running',
      ...(update.phase ? { phase: update.phase } : {}),
      ...(update.lastActivityAt ? { lastActivityAt: update.lastActivityAt } : {}),
      ...(update.url ? { delegated: { url: update.url } } : {}),
      // The executor's own name, so the run diagnostics say where the step ran rather than
      // reporting the container backend a delegated step never had.
      backend: `delegated:${definition.id}`,
    }
  }
  if (update.state === 'failed') {
    return {
      state: 'failed',
      error: update.error,
      ...(update.detail ? { detail: update.detail } : {}),
      ...(update.url ? { delegated: { url: update.url } } : {}),
      backend: `delegated:${definition.id}`,
      // A NON-retryable failure is reported as a harness shutdown, which is the driver's one
      // "terminal, do not spend a recovery budget on it" signal. A retryable one is left as a
      // plain failure, which the job-failure budget then re-drives.
      ...(update.retryable === true ? {} : { harnessShutdown: true as const }),
    }
  }
  const result = update.result
  return {
    state: 'done',
    result: {
      output: result.summary,
      ...(result.pullRequest ? { pullRequest: result.pullRequest } : {}),
      ...(result.custom !== undefined ? { custom: result.custom } : {}),
      // Tagged `subscription`, never `metered`. The tokens were spent on the EXECUTOR's own
      // account, so counting them against this workspace's budget would pause runs over money the
      // platform did not spend. `subscription` is the disposition that already means exactly this:
      // recorded for the usage report, excluded from every spend rollup.
      ...(result.usage ? { usage: result.usage, usageBilling: 'subscription' as const } : {}),
    },
  }
}

/** A logger for a delegated executor built with no facade logger wired (tests). */
export const noopDelegatedLogger: Logger = noopLogger
