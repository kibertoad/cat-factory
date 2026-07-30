<script setup lang="ts">
// The plan gate with NO document to review: the compact rail that sits above the tracker's own
// sections, states that there is nothing to navigate, and still resolves the park.
//
// It is NOT a legacy shim for gates parked before the engine rendered plans. `outputIsRendered` is a
// fact about the STEP, and a plan gate can park without it today: the planner's post-completion
// resolver authors the rendering only once it has INGESTED the plan, so a run that reaches the gate
// without an ingest parks on the planner's transcript summary instead — a perfectly non-empty string
// that `planReviewDocument` correctly reads as no document (dressing one sentence up under a table
// of contents is the failure the whole review surface exists to end). Without this surface such a
// gate would have no resolving surface at all, which is the exact bug the plan-review e2e spec was
// written for.
//
// So it is deliberately NOT a takeover: unlike `InitiativePlanReview`, which replaces the tracker
// because the document repeats it, this one wants the tracker underneath — there the sections ARE
// the only rendering of the plan there is. Which is why it has to be TOLD whether they are actually
// on screen: it renders above the entity branch, because a gate can be parked while the entity is
// still loading, and pointing a reviewer at sections the window is not showing is worse than saying
// nothing.
import type { StepApproval } from '~/types/execution'
import InitiativePlanDecision from '~/components/initiative/InitiativePlanDecision.vue'

defineProps<{
  /** The parked gate. */
  approval: StepApproval
  /** The run the gate belongs to, for the approve / request-changes commands. */
  instanceId: string
  /** Whether the viewer may resolve runs at all (RBAC); false renders the actions disabled. */
  canExecute: boolean
  /**
   * Whether the tracker's own goal / phases / policy sections are rendered below this notice — i.e.
   * whether the initiative entity has loaded. Only then may the notice point at them as the plan.
   */
  hasSections: boolean
}>()

const { t } = useI18n()
</script>

<template>
  <section
    class="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3.5"
    data-testid="initiative-plan-notice"
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
          <template v-if="hasSections">
            {{ t('initiative.planReview.noDocumentSections') }}
          </template>
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
