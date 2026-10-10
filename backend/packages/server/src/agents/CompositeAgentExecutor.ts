import {
  type AgentExecutor,
  type AgentJobHandle,
  type AgentJobUpdate,
  type AgentRunContext,
  type AgentRunResult,
  type AsyncAgentExecutor,
  isAsyncAgentExecutor,
  type Logger,
  noopLogger,
  runBestEffort,
  type RunReclaimReport,
  type RunReclaimTarget,
} from '@cat-factory/kernel'
import type { DispatchToolServers } from '@cat-factory/contracts'
import {
  type AgentKindRegistry,
  defaultAgentKindRegistry,
  runsDelegated,
  runsInContainer,
} from '@cat-factory/agents'

// Routes each pipeline step to the right executor by agent kind. The kinds that
// produce and commit files against a real checkout — implementation (`coder`),
// the external-dependency mock builder (`mocker`), the Playwright e2e test
// writer (`playwright`) and the business-logic documenter (`business-documenter`,
// which reads the implementation and commits domain-rules docs) — run in a real
// sandbox via the container executor. The `architect` also runs in a container, but
// read-only: it explores the repo before proposing (no commits, like `analysis`).
// Every other kind (reviewer and the other companions, tester, the
// `business-reviewer` that reports on a change, custom) stays on the inline LLM
// executor. This keeps container cost/latency to the phases that actually need a real
// workspace, while pure review/companion steps remain single-shot LLM calls.
//
// There is deliberately NO inline fallback for the container kinds: a one-shot
// LLM call cannot clone a repo, edit files, commit and open a PR, so routing an
// implementer step to the inline executor produces plausible-looking text that is
// silently useless. When no sandbox is wired (`container` is null), the container
// kinds throw instead — the run fails loudly rather than pretending to succeed.
//
// Runtime-neutral: both the Cloudflare Worker and the Node service wire this
// composite (inline `AiAgentExecutor` + a container executor backed by a
// per-run Cloudflare Container or an org's self-hosted runner pool).
//
// A THIRD arm routes a `delegated` kind to the deployment's own external executor (see
// `DelegatedAgentExecutor`). It is keyed off the agent-kind registry exactly as the container arm
// is, and it is the reason `pollJob` no longer hard-routes to the container: a poll rebuilds its
// handle from the step alone, so the arm has to be re-derived from the SAME declaration the
// dispatch routed on rather than assumed.

export class CompositeAgentExecutor implements AsyncAgentExecutor {
  /** The app-owned agent-kind registry: decides whether a registered custom kind needs a container. */
  private readonly registry: AgentKindRegistry
  /** Normalised once, so the one best-effort site below can log unconditionally (AGENTS.md). */
  private readonly log: Logger

  constructor(
    private readonly inline: AgentExecutor,
    // null when no sandbox is wired — container kinds then fail loudly (see below)
    // rather than silently degrading to a useless one-shot inline call.
    private readonly container: AgentExecutor | null,
    // The app-owned agent-kind registry; defaults to the built-ins-only registry when a
    // facade doesn't inject the shared instance (tests / no custom kinds).
    registry: AgentKindRegistry = defaultAgentKindRegistry(),
    // The deployment's external executors, or null when the facade wired none. Null is the
    // ordinary state: the platform ships no delegated kind, so nothing reaches this arm unless a
    // deployment registered one, and a kind that does with no executor wired fails loudly for the
    // reason an unwired container kind does.
    private readonly delegated: AgentExecutor | null = null,
    logger?: Logger,
  ) {
    this.registry = registry
    this.log = logger ?? noopLogger
  }

  /**
   * The delegated executor for this kind, or undefined when the kind does not run on one.
   *
   * Refuses LOUDLY rather than falling through when a delegated kind's arm is unwired, for exactly
   * the reason the container arm does: the fallback is an inline LLM call over an implementer's
   * prompt, which produces confident prose and no branch, and the run then advances into a `ci`
   * gate with nothing to check.
   */
  private delegatedFor(agentKind: string): AgentExecutor | undefined {
    if (!runsDelegated(agentKind, this.registry)) return undefined
    if (!this.delegated) {
      throw new Error(
        `Agent kind '${agentKind}' runs on an external (delegated) executor, and this ` +
          'deployment wired none. Register the executor on the delegated-executor registry and ' +
          'pass it to the facade entry point.',
      )
    }
    return this.delegated
  }

  /**
   * The executor that handles a given step's kind. Container kinds REQUIRE a real
   * sandbox: with none wired we throw rather than fall back to the inline executor,
   * because a one-shot LLM call cannot operate on repo contents.
   */
  private pick(context: AgentRunContext): AgentExecutor {
    // A DELEGATED kind's work happens in a system the deployment already runs. Asked FIRST,
    // because the two predicates below both answer "no" for it and the inline arm is what it would
    // otherwise fall through to: a one-shot LLM call, over a prompt written for an implementer,
    // producing plausible text and no branch. Routed off the same registry declaration the engine
    // reads, so what the pipeline builder labelled as leaving the platform is what leaves it.
    const delegated = this.delegatedFor(context.agentKind)
    if (delegated) return delegated
    // Built-in container kinds, plus any custom kind a deployment registered with
    // `requiresContainer: true` (e.g. a proprietary org package contributing a
    // repo-operating agent) and the container-backed companions, need a real checkout;
    // everything else runs inline. The predicate lives in the agent CATALOG
    // (`@cat-factory/agents`) rather than here because the engine asks the same question
    // when it tells a kind's preOps what shape of context to prepare — an agent with no
    // checkout must not be handed a manifest telling it to run `git diff`.
    if (!runsInContainer(context.agentKind, this.registry)) return this.inline
    if (!this.container) {
      throw new Error(
        `Agent kind '${context.agentKind}' needs a real checkout (clone/edit/commit/PR) ` +
          'and cannot run as a one-shot LLM call. Its sandbox prerequisites must be wired: ' +
          'a runner backend (the EXEC_CONTAINER binding on the Worker, or a registered ' +
          'runner pool with RUNNERS_ENABLED), plus the GitHub App, the public proxy URL ' +
          'and AUTH_SESSION_SECRET.',
      )
    }
    return this.container
  }

  run(context: AgentRunContext): Promise<AgentRunResult> {
    return this.pick(context).run(context)
  }

  /**
   * Preview the model the step will run, forwarding to the executor that will
   * handle its kind. Best-effort: returns undefined when the picked executor can't
   * preview. `pick` throws for an unwired container kind — that real error surfaces
   * at dispatch, so the engine treats this preview as optional and guards the call.
   */
  resolveModel(context: AgentRunContext): Promise<string | undefined> {
    const executor = this.pick(context)
    return executor.resolveModel?.(context) ?? Promise.resolve(undefined)
  }

  /**
   * Preview what an inline dispatch will do with the kind's tool servers, forwarding to the
   * executor that will handle its kind. Guarded like {@link resolveModel} and for the same reason:
   * `pick` throws for an unwired container kind, and that error belongs to the dispatch rather
   * than to a record the engine keeps beside it.
   */
  previewToolServers(context: AgentRunContext): Promise<DispatchToolServers | undefined> {
    const executor = this.pick(context)
    return executor.previewToolServers?.(context) ?? Promise.resolve(undefined)
  }

  /**
   * Whether the step runs on a flat-rate subscription (quota) model, forwarding to
   * the executor that handles its kind (only the container executor runs subscription
   * harnesses). Best-effort: an inline kind, an unwired container, or an executor
   * without the capability all report false (budget-metered, the prior behaviour).
   */
  isQuotaBased(context: AgentRunContext): Promise<boolean> {
    // A DELEGATED step spends nothing of ours: no pooled token is leased and no proxy call is
    // metered. Answered before the container check below, which would otherwise read its `false`
    // as "budget-metered" and let the spend gate account for tokens nobody here can see.
    if (runsDelegated(context.agentKind, this.registry)) return Promise.resolve(false)
    if (!this.container) return Promise.resolve(false)
    if (!runsInContainer(context.agentKind, this.registry)) return Promise.resolve(false)
    return this.container.isQuotaBased?.(context) ?? Promise.resolve(false)
  }

  /** Async only for container kinds whose executor actually supports polling. */
  runsAsync(context: AgentRunContext): boolean {
    const executor = this.pick(context)
    return isAsyncAgentExecutor(executor) && executor.runsAsync(context)
  }

  startJob(context: AgentRunContext): Promise<AgentJobHandle> {
    const executor = this.pick(context)
    if (!isAsyncAgentExecutor(executor)) {
      throw new Error(`No async executor for agent kind '${context.agentKind}'`)
    }
    return executor.startJob(context)
  }

  pollJob(handle: AgentJobHandle): Promise<AgentJobUpdate> {
    // ROUTED, not assumed. A poll rebuilds its handle from the persisted step, and a delegated
    // step's `delegated` record is what says the work is somewhere else. Read it here rather than
    // hard-routing to the container, which would poll a container that was never started and
    // settle the step against nothing.
    if (handle.delegated) {
      if (!this.delegated || !isAsyncAgentExecutor(this.delegated)) {
        throw new Error(
          `This run has work on the external executor '${handle.delegated.executor}' and this ` +
            'deployment wired no delegated executor to poll it with.',
        )
      }
      return this.delegated.pollJob(handle)
    }
    if (!this.container || !isAsyncAgentExecutor(this.container)) {
      throw new Error('Container executor does not support async jobs')
    }
    return this.container.pollJob(handle)
  }

  /**
   * Best-effort container reclaim. The engine narrows the composite (not the inner
   * container executor) when stopping a run, so the composite must forward the reclaim
   * to the container — otherwise the Layer-2 reclaim silently no-ops and leaks a
   * warm instance. Delegates only when a container that supports it is wired.
   *
   * The two arms are INDEPENDENT resources, so the second must not be gated on the first
   * succeeding. A container reclaim that throws (a DO/EKS API error, a runner-pool timeout: what
   * "best-effort" here was written for) would otherwise propagate out before the delegated arm
   * runs, and `applyDelegationCancellation` would then mark every live delegation "could not stop
   * the external work" while the executor that COULD stop it was never asked. The external run
   * carries on, opens its pull request and bills its tokens.
   */
  async reclaimRun(target: RunReclaimTarget): Promise<RunReclaimReport | void> {
    if (this.container && isAsyncAgentExecutor(this.container) && this.container.reclaimRun) {
      const reclaim = this.container.reclaimRun.bind(this.container)
      await runBestEffort(this.log, 'composite.reclaimContainer', () => reclaim(target), {
        runId: target.runId,
      })
    }
    // BOTH arms, always, and the second one ANSWERS. A run can hold a container and external work
    // at once (a delegated implementer followed by a container fixer), so reclaiming one is not
    // reclaiming the run; and whether the external half actually stopped is a fact only its
    // executor knows, which is what the report carries back to the record.
    if (!target.delegations?.length) return
    if (this.delegated && isAsyncAgentExecutor(this.delegated) && this.delegated.reclaimRun) {
      return this.delegated.reclaimRun(target)
    }
    // Named rather than dropped: the run is being torn down with external work still running and
    // nothing here able to stop it, which is precisely the state the record must not render as a
    // clean teardown.
    return {
      delegations: target.delegations.map((handle) => ({
        correlationKey: handle.correlationKey,
        cancelled: false,
        note: 'This deployment wired no delegated executor, so the external work was left running.',
      })),
    }
  }
}
