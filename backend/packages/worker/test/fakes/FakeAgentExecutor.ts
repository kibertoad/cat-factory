import type {
  AgentExecutor,
  AgentRunContext,
  AgentRunResult,
  PullRequestRef,
} from '@cat-factory/core'

export interface FakeAgentOptions {
  /** Confidence reported on the final step (drives auto-merge vs PR). Default 1. */
  confidence?: number
  /** Step indices that should raise a decision (once) before completing. */
  decisionOnSteps?: number[]
  /** Token usage reported per call, so the spend safeguard can be exercised. */
  usage?: { inputTokens: number; outputTokens: number }
  /** A PR the (container-flavoured) agent reports opening, so persistence can be exercised. */
  pullRequest?: PullRequestRef
}

/**
 * Deterministic agent for integration tests. It performs no network calls and
 * behaves predictably, so the engine's orchestration (step advancement,
 * decisions, finalisation) can be asserted exactly — without the cost or
 * nondeterminism of a real LLM.
 */
export class FakeAgentExecutor implements AgentExecutor {
  constructor(private readonly options: FakeAgentOptions = {}) {}

  async run(context: AgentRunContext): Promise<AgentRunResult> {
    const raisesDecision =
      this.options.decisionOnSteps?.includes(context.stepIndex) && !context.resolvedDecision
    if (raisesDecision) {
      return {
        decision: {
          question: `Decision for ${context.agentKind}?`,
          options: ['Option A', 'Option B'],
        },
        usage: this.options.usage,
      }
    }

    return {
      output: `[${context.agentKind}] processed "${context.block.title}"`,
      model: 'fake',
      confidence: context.isFinalStep ? (this.options.confidence ?? 1) : undefined,
      usage: this.options.usage,
      // Mimic the container "implementer" agent opening a PR for repo-operating work.
      ...(this.options.pullRequest ? { pullRequest: this.options.pullRequest } : {}),
    }
  }
}
