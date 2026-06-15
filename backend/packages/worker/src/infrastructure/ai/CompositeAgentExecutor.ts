import type { AgentExecutor, AgentRunContext, AgentRunResult } from '@cat-factory/core'

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
const CONTAINER_KINDS = new Set(['coder', 'mocker', 'playwright', 'business-documenter'])

export class CompositeAgentExecutor implements AgentExecutor {
  constructor(
    private readonly inline: AgentExecutor,
    private readonly container: AgentExecutor,
  ) {}

  run(context: AgentRunContext): Promise<AgentRunResult> {
    const executor = CONTAINER_KINDS.has(context.agentKind) ? this.container : this.inline
    return executor.run(context)
  }
}
