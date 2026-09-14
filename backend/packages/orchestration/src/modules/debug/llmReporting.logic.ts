import { delegatedSpendUnreported, type LlmReportingGaps } from '@cat-factory/contracts'
import type { ExecutionInstance } from '@cat-factory/kernel'

/**
 * What a run's model-activity totals DO NOT cover: the steps whose work ran on an external
 * executor that filed no usage.
 *
 * It exists because absence in a NUMBER is invisible. A delegated step bypasses the LLM proxy, the
 * harness call recorder and the tool-trajectory drain, so its tokens are in nobody's sink and its
 * cost is in no total, and a run whose implementing step ran on somebody else's CI therefore
 * reports a small, complete-looking figure. A person reads that as a cheap task; a cost dashboard
 * sums it; a model asked why it was cheap answers from it. Stating the gap beside the total is the
 * only thing that stops all three.
 *
 * A step counts when contracts' `delegatedSpendUnreported` says so: its external work has SETTLED
 * and nothing about its model calls reached the platform. The rule lives there rather than here
 * because the SPA has to reach the same verdict for the step card's "usage not reported" line, and
 * two statements of it drifted in both directions at once.
 *
 * Zero is a real answer and the field is always present, for the reason this whole fold exists: an
 * ABSENT `reporting` and a zero count are the same JSON value and opposite facts, and a reader that
 * had to tell them apart would be back where it started.
 */
export function llmReportingGaps(
  execution: Pick<ExecutionInstance, 'steps'> | null | undefined,
): LlmReportingGaps {
  const executors: string[] = []
  let delegatedStepsWithoutUsage = 0
  for (const step of execution?.steps ?? []) {
    if (!delegatedSpendUnreported(step)) continue
    delegatedStepsWithoutUsage += 1
    const executor = step.delegated?.executor
    if (executor && !executors.includes(executor)) executors.push(executor)
  }
  return { delegatedStepsWithoutUsage, executors }
}
