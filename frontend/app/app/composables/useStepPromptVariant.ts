import { computed, type ComputedRef } from 'vue'
import type { PipelineStep } from '~/types/execution'

// The deployment-registered agent-kind VARIANT a step ran under, as the run panels report it.
//
// Read off the dispatch-time PIN (`step.promptVariant`), never off `stepOptions.agentVariantId`:
// the option is what the pipeline ASKED for, and the two diverge whenever the workspace has also
// edited that kind's prompt — the workspace is the narrower tier, so it displaces a variant's own
// replacement. A panel keyed on the selection would report `Prompt variant: TDD-first` on a step
// whose prompt contains none of that variant's text, which is worse than saying nothing: it reads
// as confirmation. So each losing disposition gets its own note rather than being flattened into
// the label, because they need different fixes (drop the workspace's edit / use an addition
// instead of a replacement / re-register the variant).
//
// Absent before the step dispatches, exactly like `step.model` beside it: what a step RAN under is
// not a fact until it runs.

/** The dispatch-time pin a panel reads (`PipelineStep.promptVariant`), narrowed to non-null. */
type PromptVariantPin = NonNullable<PipelineStep['promptVariant']>

/** What a panel shows for a step's variant: the label, plus a note when it did not fully apply. */
export interface StepPromptVariant {
  /** The variant's registered label, falling back to its raw id when it is no longer registered. */
  label: string
  /** Why the variant's text did not (fully) reach this step's prompt; null when it did. */
  note: string | null
}

export function useStepPromptVariant(
  step: () => PipelineStep,
): ComputedRef<StepPromptVariant | null> {
  const agents = useAgentsStore()
  const { t } = useI18n()
  // One STATIC literal `t()` per member of the closed disposition union, not a key assembled from
  // `applied`: the typed-message-key check and the catalog drift guard both read literal keys, and
  // a runtime-assembled one is invisible to them. The `Record` type is the exhaustiveness half —
  // a new disposition fails to compile until it has copy.
  const NOTE: Record<PromptVariantPin['applied'], () => string | null> = {
    full: () => null,
    'addition-only': () => t('panels.stepMeta.promptVariantAdditionOnly'),
    superseded: () => t('panels.stepMeta.promptVariantSuperseded'),
    withdrawn: () => t('panels.stepMeta.promptVariantWithdrawn'),
  }

  return computed(() => {
    const pin = step().promptVariant
    if (!pin) return null
    return { label: agents.variantLabel(pin.id), note: NOTE[pin.applied]() }
  })
}
