import { DECISION_BANK, DECISION_CHANCE } from '../../domain/catalog'
import type {
  AgentExecutor,
  AgentRunContext,
  AgentRunResult,
} from '../../ports/agent-executor'
import type { Rng } from '../../ports/runtime'

export interface SimulatorAgentExecutorDependencies {
  rng: Rng
}

/**
 * The "playful" agent: reproduces the randomised experience the frontend
 * prototype used to hardcode — agents that occasionally pause for a human
 * decision and finish with a random confidence score — but as a proper agent
 * behind the same port. Intended for local / mock runtime only; tests use a
 * deterministic fake instead, so the engine they exercise stays predictable.
 */
export class SimulatorAgentExecutor implements AgentExecutor {
  private readonly rng: Rng

  constructor({ rng }: SimulatorAgentExecutorDependencies) {
    this.rng = rng
  }

  async run(context: AgentRunContext): Promise<AgentRunResult> {
    // Maybe pause for a decision — but never if this step's decision was already
    // resolved (otherwise it would block forever).
    if (!context.resolvedDecision) {
      const bank = DECISION_BANK[context.agentKind]
      if (bank?.length && this.rng.next() < DECISION_CHANCE) {
        const pick = bank[Math.floor(this.rng.next() * bank.length)]!
        return { decision: { question: pick.question, options: [...pick.options] } }
      }
    }

    const decided = context.resolvedDecision
      ? ` (decided: ${context.resolvedDecision.chosen})`
      : ''
    return {
      output: `[${context.agentKind}] completed work on "${context.block.title}"${decided}`,
      model: 'simulator',
      confidence: Math.round((0.5 + this.rng.next() * 0.5) * 100) / 100,
    }
  }
}
