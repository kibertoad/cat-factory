import type {
  AgentExecutor,
  AgentRunContext,
  AgentRunResult,
  PullRequestRef,
} from '@cat-factory/kernel'

export interface FakeAgentOptions {
  /** Confidence reported on the final step (drives auto-merge vs PR). Default 1. */
  confidence?: number
  /** Step indices that should raise a decision (once) before completing. */
  decisionOnSteps?: number[]
  /** Token usage reported per call, so the spend safeguard can be exercised. */
  usage?: { inputTokens: number; outputTokens: number }
  /** A PR the (container-flavoured) agent reports opening, so persistence can be exercised. */
  pullRequest?: PullRequestRef
  /**
   * A blueprint tree the `blueprints` step reports, so the engine's ingest +
   * board reconcile can be exercised without a real container.
   */
  blueprintService?: unknown
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

    // Mimic the container Blueprinter step returning a decomposition tree.
    if (context.agentKind === 'blueprints' && this.options.blueprintService !== undefined) {
      return {
        output: `[blueprints] mapped "${context.block.title}"`,
        model: 'fake',
        blueprintService: this.options.blueprintService,
      }
    }

    // Surface revision feedback so a "request changes" re-run can be asserted.
    const revisionSuffix = context.revision ? ` [revised: ${context.revision.feedback}]` : ''
    return {
      output: `[${context.agentKind}] processed "${context.block.title}"${revisionSuffix}`,
      model: 'fake',
      confidence: context.isFinalStep ? (this.options.confidence ?? 1) : undefined,
      usage: this.options.usage,
      // Mimic the container "implementer" agent opening a PR for repo-operating work.
      ...(this.options.pullRequest ? { pullRequest: this.options.pullRequest } : {}),
    }
  }
}
