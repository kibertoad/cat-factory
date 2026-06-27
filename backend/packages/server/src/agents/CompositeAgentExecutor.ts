import {
  type AgentExecutor,
  type AgentJobHandle,
  type AgentJobUpdate,
  type AgentRunContext,
  type AgentRunResult,
  type AsyncAgentExecutor,
  isAsyncAgentExecutor,
} from '@cat-factory/kernel'
import { registeredKindRequiresContainer } from '@cat-factory/agents'

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

/**
 * Agent kinds that need a real checkout to operate on repo contents (clone,
 * edit/commit files, open a PR) and so run in a container rather than inline:
 * code implementation (`coder`), WireMock mock building (`mocker`), Playwright
 * end-to-end test authoring (`playwright`) and business-logic documentation
 * (`business-documenter`, which reads the code and commits the domain-rules docs).
 */
const CONTAINER_KINDS = new Set([
  'coder',
  'mocker',
  'playwright',
  'business-documenter',
  // The Blueprinter step clones the repo, regenerates the in-repo `blueprints/`
  // folder and commits it — a real-checkout operation, so it runs in a container.
  'blueprints',
  // The spec-writer clones (or creates) the implementation branch and commits the
  // in-repo `spec/` folder onto it — a real-checkout operation, so it runs in a
  // container. Like the blueprinter it returns a structured doc.
  'spec-writer',
  // The architect explores the repository (read-only) before proposing a design, so
  // it needs a real checkout. Like `analysis` it makes no edits — the harness produces
  // no commit and opens no PR — and returns its proposal as prose `output`.
  'architect',
  // The CI-fixer clones the PR head branch, runs the failing build/tests, fixes
  // them and pushes back to the same branch — a real-checkout operation. (The `ci`
  // step itself is NOT here: it is a special, non-agent gate handled in the engine
  // that *dispatches* a `ci-fixer` job; only the fixer reaches this executor.)
  'ci-fixer',
  // The conflict-resolver clones the PR head branch, merges the base in and resolves
  // the conflicts on the same branch — a real-checkout operation. (The `conflicts`
  // gate itself is NOT here: like `ci` it is a non-agent engine gate that *dispatches*
  // a `conflict-resolver` job; only the resolver reaches this executor.)
  'conflict-resolver',
  // The merger clones the PR head branch to assess the diff (complexity/risk/impact)
  // before the engine decides whether to auto-merge — a real-checkout operation.
  'merger',
  // The tech-debt `analysis` agent clones the repo to inspect it and emit a report.
  // It is read-only (makes no edits) so the coding-agent harness produces no commit
  // and opens no PR — but it still needs a real checkout, so it runs in a container.
  'analysis',
  // The tester clones the PR branch, stands up infra (local docker-compose or an
  // ephemeral env), runs the suite and returns a structured report — a real-checkout
  // operation. (The tester step is also a special engine gate that loops a `fixer`
  // on a withheld greenlight, mirroring `ci`/`ci-fixer`; the engine dispatches both
  // jobs, which reach this executor.) `tester-api` is the general/API tester;
  // `tester-ui` is its browser-driven, screenshot-capturing sibling (UI-tester image).
  'tester-api',
  'tester-ui',
  // The fixer clones the PR head branch, applies fixes from the Tester's report and
  // pushes back to the same branch — a real-checkout operation, like `ci-fixer`.
  'fixer',
  // The on-call agent clones the released PR head to correlate its diff with the
  // Datadog regression evidence and returns a JSON assessment — a real-checkout
  // operation (makes no commits). (The `post-release-health` gate itself is NOT here:
  // like `ci` it is a non-agent engine gate that *dispatches* an `on-call` job; only
  // the on-call agent reaches this executor.)
  'on-call',
])

export class CompositeAgentExecutor implements AsyncAgentExecutor {
  constructor(
    private readonly inline: AgentExecutor,
    // null when no sandbox is wired — container kinds then fail loudly (see below)
    // rather than silently degrading to a useless one-shot inline call.
    private readonly container: AgentExecutor | null,
  ) {}

  /**
   * The executor that handles a given step's kind. Container kinds REQUIRE a real
   * sandbox: with none wired we throw rather than fall back to the inline executor,
   * because a one-shot LLM call cannot operate on repo contents.
   */
  private pick(context: AgentRunContext): AgentExecutor {
    // Built-in container kinds, plus any custom kind a deployment registered with
    // `requiresContainer: true` (e.g. a proprietary org package contributing a
    // repo-operating agent), need a real checkout; everything else runs inline.
    const needsContainer =
      CONTAINER_KINDS.has(context.agentKind) || registeredKindRequiresContainer(context.agentKind)
    if (!needsContainer) return this.inline
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
   * Whether the step runs on a flat-rate subscription (quota) model, forwarding to
   * the executor that handles its kind (only the container executor runs subscription
   * harnesses). Best-effort: an inline kind, an unwired container, or an executor
   * without the capability all report false (budget-metered, the prior behaviour).
   */
  isQuotaBased(context: AgentRunContext): Promise<boolean> {
    if (!this.container) return Promise.resolve(false)
    const needsContainer =
      CONTAINER_KINDS.has(context.agentKind) || registeredKindRequiresContainer(context.agentKind)
    if (!needsContainer) return Promise.resolve(false)
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
   * container executor) when stopping a run, so the composite must forward stopJob
   * to the container — otherwise the Layer-2 reclaim silently no-ops and leaks a
   * warm instance. Delegates only when a container that supports it is wired.
   */
  async stopJob(handle: AgentJobHandle): Promise<void> {
    if (this.container && isAsyncAgentExecutor(this.container) && this.container.stopJob) {
      await this.container.stopJob(handle)
    }
  }
}
