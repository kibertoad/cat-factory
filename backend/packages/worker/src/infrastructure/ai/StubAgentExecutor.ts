import type { AgentExecutor, AgentRunContext, AgentRunResult } from '@cat-factory/core'

/**
 * The agent used when LLM execution is disabled (the default) or in tests. It
 * performs no network calls and returns a deterministic, human-readable summary,
 * keeping the simulation fully functional and reproducible without an LLM.
 */
export class StubAgentExecutor implements AgentExecutor {
  async run(context: AgentRunContext): Promise<AgentRunResult> {
    const decisions = context.decisions.map((d) => d.chosen).join(', ')
    const suffix = decisions ? ` (decided: ${decisions})` : ''
    return {
      output: `[${context.agentKind}] completed work on "${context.block.title}"${suffix}`,
      model: 'stub',
    }
  }
}
