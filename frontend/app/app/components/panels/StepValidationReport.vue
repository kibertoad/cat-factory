<script setup lang="ts">
import { computed } from 'vue'
import type { ValidationReport } from '~/types/validationChecks'

// The PRE-PR VALIDATION report for a step: which of the service's configured check commands
// passed against the checkout before the PR was allowed to open, their exit codes, and a
// bounded, secret-scrubbed tail of each command's output. Produced by the executor-harness
// running the commands — never a model self-report — so this is the run's captured PROOF on a
// green run and its EVIDENCE on a failed one. See docs/initiatives/pre-pr-validation.md.
const props = defineProps<{ report: ValidationReport }>()
const { t } = useI18n()

const failed = computed(() => props.report.outcomes.filter((o) => !o.passed))
</script>

<template>
  <div class="space-y-2" data-testid="step-validation-report">
    <p class="text-[11px] text-slate-400">
      {{
        report.passed
          ? t('panels.stepDetail.validation.passedSummary', {
              total: report.outcomes.length,
              attempts: report.attempts,
            })
          : t('panels.stepDetail.validation.failedSummary', {
              failed: failed.length,
              total: report.outcomes.length,
              attempts: report.attempts,
              maxAttempts: report.maxAttempts,
            })
      }}
    </p>

    <div
      v-for="outcome in report.outcomes"
      :key="outcome.label"
      class="rounded-md border border-slate-800 bg-slate-950/40 p-2"
      data-testid="validation-outcome"
    >
      <div class="flex items-center gap-2">
        <UIcon
          :name="outcome.passed ? 'i-lucide-check' : 'i-lucide-x'"
          class="h-3.5 w-3.5 shrink-0"
          :class="outcome.passed ? 'text-emerald-400' : 'text-rose-400'"
        />
        <span class="text-[12px] font-medium text-slate-200">{{ outcome.label }}</span>
        <span class="truncate font-mono text-[11px] text-slate-500">{{ outcome.command }}</span>
        <span
          v-if="!outcome.passed"
          class="ms-auto shrink-0 rounded bg-rose-500/15 px-1.5 py-0.5 text-[11px] tabular-nums text-rose-300"
        >
          {{
            outcome.timedOut
              ? t('panels.stepDetail.validation.timedOut')
              : t('panels.stepDetail.validation.exitCode', { code: outcome.exitCode })
          }}
        </span>
      </div>
      <pre
        v-if="outcome.outputTail"
        class="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-2 font-mono text-[11px] text-slate-400"
        data-testid="validation-output"
        >{{ outcome.outputTail }}</pre>
    </div>
  </div>
</template>
