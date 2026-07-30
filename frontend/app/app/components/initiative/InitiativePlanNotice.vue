<script setup lang="ts">
// The plan gate with NO document to review: the compact rail that sits above the tracker's own
// sections, states why there is nothing to navigate, and still resolves the park.
//
// It exists because `outputIsRendered` is a fact about the STEP, not about the plan: a run planned
// before the engine rendered plans for review parks on the planner's transcript summary, which is a
// perfectly non-empty string. `planReviewDocument` reads it as no document (dressing one sentence
// up under a table of contents is the failure the whole review surface exists to end), and this is
// what a human gets instead — the two commands, plus a notice pointing at the ingested plan in the
// sections below, which at that point ARE the only rendering of it there is.
//
// So it is deliberately NOT a takeover: unlike `InitiativePlanReview`, which replaces the tracker
// because the document repeats it, this one needs the tracker underneath to be the plan.
import type { StepApproval } from '~/types/execution'
import InitiativePlanDecision from '~/components/initiative/InitiativePlanDecision.vue'

defineProps<{
  /** The parked gate. */
  approval: StepApproval
  /** The run the gate belongs to, for the approve / request-changes commands. */
  instanceId: string
  /** Whether the viewer may resolve runs at all (RBAC); false renders the actions disabled. */
  canExecute: boolean
}>()

const { t } = useI18n()
</script>

<template>
  <section
    class="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3.5"
    data-testid="initiative-plan-review"
  >
    <header class="flex items-start gap-2.5">
      <UIcon name="i-lucide-clipboard-check" class="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
      <div class="min-w-0 flex-1">
        <h3 class="text-[13px] font-semibold text-amber-200">
          {{ t('initiative.planReview.title') }}
        </h3>
        <p class="mt-0.5 text-[12px] leading-relaxed text-amber-100/80">
          {{ t('initiative.planReview.body') }}
        </p>
        <p class="mt-2 text-[12px] leading-relaxed text-amber-100/70">
          {{ t('initiative.planReview.noDocument') }}
        </p>
      </div>
    </header>
    <InitiativePlanDecision
      class="mt-3"
      :approval-id="approval.id"
      :instance-id="instanceId"
      :can-execute="canExecute"
    />
  </section>
</template>
