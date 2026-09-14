import type { LlmReportingGaps } from '@cat-factory/contracts'
import type { ExecutionInstance, PipelineStep } from '@cat-factory/kernel'

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
 * A step counts when its external work has SETTLED and it reported no usage back. A step whose
 * executor self-reports and has filed is not a gap, and neither is one that is still running: the
 * second is what makes the status check load-bearing rather than decorative, because a
 * `self-reported` executor files with its result and has therefore reported nothing, correctly, for
 * the whole time the work is in flight.
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
    if (!isUnreportedDelegatedStep(step)) continue
    delegatedStepsWithoutUsage += 1
    const executor = step.delegated?.executor
    if (executor && !executors.includes(executor)) executors.push(executor)
  }
  return { delegatedStepsWithoutUsage, executors }
}

/**
 * Whether this step's spend is missing from the run's totals.
 *
 * Read off the STEP's own record rather than the executor's declared `telemetry`, and deliberately:
 * the declaration is a deployment's intention, and what a reader needs is what actually landed. An
 * executor that declares `self-reported` and silently stops filing is precisely the case a
 * declaration-based check would report as covered.
 */
function isUnreportedDelegatedStep(step: PipelineStep): boolean {
  const record = step.delegated
  if (!record) return false
  // Work still IN FLIGHT is not a gap, and this is the check that keeps the two counts apart. An
  // executor that declares `self-reported` files its usage with the result, so between the claim
  // and the settlement it has reported nothing and is SUPPOSED to have reported nothing. Counting
  // it would merge "has not filed yet" with "never will", which is the one distinction the field's
  // own contract insists must survive, and it would do so on exactly the reads a person takes
  // while watching a run.
  if (record.status === 'starting' || record.status === 'running') return false
  // `metrics` is the per-step LLM rollup the observability sink folds. Absent, or present with no
  // calls in it, both mean the same thing here: nothing about this step's model work reached the
  // platform.
  return (step.metrics?.calls ?? 0) === 0
}
