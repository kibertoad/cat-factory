import type { AgentExecutor, AgentRunContext, AgentRunResult } from '@cat-factory/core'

// Routes each pipeline step to the right executor by agent kind. Implementation
// (`coder`/`build`) steps run in a real sandbox via the container executor;
// every other kind (architect, reviewer, tester, custom) stays on the inline
// LLM executor. This keeps container cost/latency to the one phase that needs a
// real workspace, while design/review/test remain single-shot LLM calls.

/** Agent kinds that should run as real code implementation in a container. */
const CONTAINER_KINDS = new Set(['coder'])

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
