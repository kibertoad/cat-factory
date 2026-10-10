<script setup lang="ts">
import { computed } from 'vue'
import type { ReproductionPhaseOutcome, ReproductionReport } from '~/types/reproduction'
import { REPRODUCTION_STATUS_KEYS, REPRODUCTION_TREE_KEYS } from '~/utils/reproduction'
import SectionLabel from '~/components/common/SectionLabel.vue'

// The BUGFIX REPRODUCTION PROOF for a step: the declared reproducing check as the
// executor-harness ran it against the pre-fix tree and against the final tree, with both captured
// outputs. The verdict is computed from the two exit codes by the harness — never self-reported by
// the model, which is the entire point (the `repro-test` kind's own `outcome` has always been the
// agent's CLAIM, and this is what checks it). See
// backend/docs/adr/0033-bugfix-reproduction-proof.md.
//
// Two callers, one renderer, exactly as `StepEffortReport` has: the generic step-detail panel drops
// it in as a `card` (its own heading + border, among the other detail sections) and
// `ResultWindowShell`'s collapsible footer embeds it `flat`, where the disclosure row is already
// the heading. BOTH are needed, and that is the point: the engine records the proof on whichever
// step OPENED the pull request — in every built-in pipeline the `coder`, whose kind declares no
// result view and therefore opens the step-detail panel the shell is not involved in.
const props = withDefaults(
  defineProps<{ report: ReproductionReport; variant?: 'card' | 'flat' }>(),
  { variant: 'flat' },
)
const { t } = useI18n()

/**
 * The two trees, as rows. An ABSENT final run is normal rather than missing data: a green pre-fix
 * tree already settles the verdict, so running the second one could only confirm what is already
 * not proof — and each run costs a full setup plus test. The row says which, instead of leaving a
 * blank a reader would read as a failure to record.
 */
const phases = computed(() => [
  { key: 'base' as const, label: REPRODUCTION_TREE_KEYS.base, outcome: props.report.base },
  { key: 'final' as const, label: REPRODUCTION_TREE_KEYS.final, outcome: props.report.final },
])

/** The verdict's copy + icon, from the exhaustive lookup rather than an assembled key. */
const presentation = computed(() => REPRODUCTION_STATUS_KEYS[props.report.status])

/** A phase's result chip: setup failure and timeout are their own answers, not plain failures. */
function phaseLabel(outcome: ReproductionPhaseOutcome): string {
  if (outcome.setupFailed) return t('panels.stepDetail.reproduction.setupFailed')
  if (outcome.timedOut) return t('panels.stepDetail.reproduction.timedOut')
  return outcome.passed
    ? t('panels.stepDetail.reproduction.passed')
    : t('panels.stepDetail.reproduction.exitCode', { code: outcome.exitCode })
}
</script>

<template>
  <section
    class="space-y-2"
    data-testid="step-reproduction-report"
    :class="
      variant === 'card' ? 'scroll-mt-4 rounded-xl border border-default bg-default/50 p-4' : ''
    "
  >
    <SectionLabel v-if="variant === 'card'" class="flex items-center gap-1.5">
      <UIcon :name="presentation.icon" class="h-3.5 w-3.5" />
      <span>{{ t('panels.stepDetail.reproduction.heading') }}</span>
    </SectionLabel>

    <p class="text-2xs text-muted" data-testid="reproduction-verdict">
      {{ t(presentation.verdict) }}
    </p>

    <!-- The producer's own one-line diagnosis, rendered VERBATIM. Only the side that ran the two
         trees can tell a test that misses the defect from a resumed run whose pre-fix tree already
         carried this step's own interrupted work, so re-deriving a cause from the exit codes here
         is exactly the inference that gets it wrong. -->
    <p
      v-if="report.note"
      class="text-2xs text-app-warning-300"
      data-testid="reproduction-observation"
    >
      {{ report.note }}
    </p>

    <!-- A structural infeasibility declaration: the reason, and what the agent verified instead.
         This is what keeps "could not be reproduced" from looking like "nobody tried". -->
    <template v-if="report.status === 'declared_infeasible'">
      <div v-if="report.reason" class="rounded-md border border-default bg-app-950/40 p-2">
        <SectionLabel as="p">
          {{ t('panels.stepDetail.reproduction.reason') }}
        </SectionLabel>
        <p class="mt-1 whitespace-pre-wrap text-xs text-toned">{{ report.reason }}</p>
      </div>
      <div
        v-if="report.alternativeVerification"
        class="rounded-md border border-default bg-app-950/40 p-2"
      >
        <SectionLabel as="p">
          {{ t('panels.stepDetail.reproduction.alternative') }}
        </SectionLabel>
        <p class="mt-1 whitespace-pre-wrap text-xs text-toned">
          {{ report.alternativeVerification }}
        </p>
      </div>
    </template>

    <template v-else>
      <div v-if="report.command" class="flex items-baseline gap-2">
        <span class="shrink-0 text-2xs text-dimmed">{{
          t('panels.stepDetail.reproduction.command')
        }}</span>
        <span class="truncate font-mono text-2xs text-toned">{{ report.command }}</span>
      </div>

      <!-- A dropped path can leave the pre-fix tree without the reproduction, which greens it and
           reads as "the test does not capture the defect". Stated, never implied. -->
      <p
        v-if="report.omittedTestPaths"
        class="text-2xs text-app-warning-300"
        data-testid="reproduction-omitted-paths"
      >
        {{
          t(
            'panels.stepDetail.reproduction.omittedTestPaths',
            { count: report.omittedTestPaths },
            report.omittedTestPaths,
          )
        }}
      </p>

      <div
        v-for="phase in phases"
        :key="phase.key"
        class="rounded-md border border-default bg-app-950/40 p-2"
        data-testid="reproduction-phase"
      >
        <div class="flex items-center gap-2">
          <UIcon
            :name="phase.outcome?.passed ? 'i-lucide-check' : 'i-lucide-x'"
            class="h-3.5 w-3.5 shrink-0"
            :class="
              phase.outcome
                ? phase.outcome.passed
                  ? 'text-app-success-400'
                  : 'text-app-error-400'
                : 'text-app-600'
            "
          />
          <span class="text-xs font-medium text-default">
            {{ t(phase.label) }}
          </span>
          <span class="ms-auto shrink-0 text-2xs tabular-nums text-muted">
            {{
              phase.outcome ? phaseLabel(phase.outcome) : t('panels.stepDetail.reproduction.notRun')
            }}
          </span>
        </div>
        <pre
          v-if="phase.outcome?.outputTail"
          class="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-app-950 p-2 font-mono text-2xs text-muted"
          data-testid="reproduction-output"
          >{{ phase.outcome.outputTail }}</pre>
      </div>

      <p class="text-2xs text-dimmed">
        {{
          t('panels.stepDetail.reproduction.attempts', {
            attempts: report.attempts,
            maxAttempts: report.maxAttempts,
          })
        }}
      </p>
    </template>
  </section>
</template>
