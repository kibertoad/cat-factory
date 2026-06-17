import {
  type AgentExecutor,
  type AgentJobHandle,
  type AgentJobUpdate,
  type AgentRunContext,
  type AgentRunResult,
  type AsyncAgentExecutor,
  isAsyncAgentExecutor,
} from '@cat-factory/core'

// Routes each pipeline step to the right executor by agent kind. The kinds that
// produce and commit files against a real checkout — implementation (`coder`),
// the external-dependency mock builder (`mocker`), the Playwright e2e test
// writer (`playwright`) and the business-logic documenter (`business-documenter`,
// which reads the implementation and commits domain-rules docs) — run in a real
// sandbox via the container executor; every other kind (architect, reviewer,
// tester, the `acceptance` scenario writer, the `business-reviewer` that reports
// on a change, custom) stays on the inline LLM executor. This keeps container
// cost/latency to the phases that actually need a real workspace to operate on
// repo contents, while pure design/review/analysis steps remain single-shot LLM
// calls.

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
])

export class CompositeAgentExecutor implements AsyncAgentExecutor {
  constructor(
    private readonly inline: AgentExecutor,
    private readonly container: AgentExecutor,
  ) {}

  /** The executor that handles a given step's kind. */
  private pick(context: AgentRunContext): AgentExecutor {
    return CONTAINER_KINDS.has(context.agentKind) ? this.container : this.inline
  }

  run(context: AgentRunContext): Promise<AgentRunResult> {
    return this.pick(context).run(context)
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
    if (!isAsyncAgentExecutor(this.container)) {
      throw new Error('Container executor does not support async jobs')
    }
    return this.container.pollJob(handle)
  }
}
