import { computed, type ComputedRef, type MaybeRefOrGetter, toValue } from 'vue'
import {
  bootstrapResumeStep,
  bootstrapRunSteps,
  type BootstrapRunStep,
  type BootstrapStepId,
} from '@cat-factory/contracts'
import { useAgentRunsStore } from '~/stores/agentRuns'

/**
 * A bootstrap run projected onto its steps, for the surfaces that render them and for the
 * button that resumes one.
 *
 * The projection itself lives in `@cat-factory/contracts` and is shared with the backend, which
 * BRANCHES on the same rule (`bootstrapResume`) in `BootstrapService.retry`; this side needs only
 * the step it answers with, never the state it carries. What this composable adds is the
 * one SPA-side question the backend never asks: whether the run has more than one step at all.
 * A new-repo bootstrap is a single move, so for it a step list restates the banner it sits under
 * and "resume from…" is a promise about progress there is none of: it simply starts again.
 */
export function useBootstrapRunSteps(runId: MaybeRefOrGetter<string | null | undefined>): {
  /** The run's steps in order, with the reached one carrying the run's state. Empty if unknown. */
  steps: ComputedRef<BootstrapRunStep[]>
  /** Whether the run is a multi-step (monorepo) one: the gate every caller here needs. */
  multiStep: ComputedRef<boolean>
  /** The step a retry re-enters at, or null when the run is single-step or unknown. */
  resumeStep: ComputedRef<BootstrapStepId | null>
} {
  const agentRuns = useAgentRunsStore()
  const job = computed(() => agentRuns.bootstrapById(toValue(runId)))
  const steps = computed<BootstrapRunStep[]>(() => (job.value ? bootstrapRunSteps(job.value) : []))
  const multiStep = computed(() => steps.value.length > 1)
  const resumeStep = computed<BootstrapStepId | null>(() =>
    job.value && multiStep.value ? bootstrapResumeStep(job.value) : null,
  )
  return { steps, multiStep, resumeStep }
}
