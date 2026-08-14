import {
  type AgentExecutor,
  type AgentJobHandle,
  type AgentJobUpdate,
  type AgentRunContext,
  type AgentRunResult,
  type AsyncAgentExecutor,
  isAsyncAgentExecutor,
  type RunReclaimTarget,
} from '@cat-factory/kernel'
import type { DispatchToolServers } from '@cat-factory/contracts'
import {
  type AgentKindRegistry,
  defaultAgentKindRegistry,
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

export class CompositeAgentExecutor implements AsyncAgentExecutor {
  /** The app-owned agent-kind registry: decides whether a registered custom kind needs a container. */
  private readonly registry: AgentKindRegistry

  constructor(
    private readonly inline: AgentExecutor,
    // null when no sandbox is wired — container kinds then fail loudly (see below)
    // rather than silently degrading to a useless one-shot inline call.
    private readonly container: AgentExecutor | null,
    // The app-owned agent-kind registry; defaults to the built-ins-only registry when a
    // facade doesn't inject the shared instance (tests / no custom kinds).
    registry: AgentKindRegistry = defaultAgentKindRegistry(),
  ) {
    this.registry = registry
  }

  /**
   * The executor that handles a given step's kind. Container kinds REQUIRE a real
   * sandbox: with none wired we throw rather than fall back to the inline executor,
   * because a one-shot LLM call cannot operate on repo contents.
   */
  private pick(context: AgentRunContext): AgentExecutor {
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
    // Only the container executor runs async jobs, so polls route there.
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
   */
  async reclaimRun(target: RunReclaimTarget): Promise<void> {
    if (this.container && isAsyncAgentExecutor(this.container) && this.container.reclaimRun) {
      await this.container.reclaimRun(target)
    }
  }
}
