<script setup lang="ts">
import type { RequirementVerdictStatus, TestReport } from '~/types/domain'
import type { TesterStepState } from '~/types/execution'
import { resolveVerdictMeta, type VerdictMeta } from './StepTestReport.logic'
import MarkdownProse from '~/components/common/MarkdownProse.vue'
import SectionLabel from '~/components/common/SectionLabel.vue'

// A tester step's latest structured report (what was tested, the per-area outcomes,
// the concerns it raised and the greenlight verdict) plus the fixer-loop phase.
defineProps<{
  report: TestReport
  phase: TesterStepState | null
}>()

const { t } = useI18n()

const SEVERITY_COLOR: Record<string, string> = {
  low: 'var(--ui-text-muted)',
  medium: 'var(--ui-warning)',
  high: 'var(--app-hue-orange)',
  critical: 'var(--ui-error)',
}
const OUTCOME_COLOR: Record<string, string> = {
  passed: 'var(--ui-success)',
  failed: 'var(--ui-error)',
  skipped: 'var(--ui-text-muted)',
}

// Per-spec-requirement verdict labels, keyed by the requirement id the service's in-repo `spec/`
// carries. THREE-VALUED on purpose: "we didn't check" and "it's broken" must never render the
// same, which is the whole reason the tester reports the list. Exhaustive `Record` over the
// closed union (drift guard tier 2) with literal `t()` keys, so a new status fails the
// typecheck rather than rendering a raw enum value. Colours and the unknown-status fallback live
// in the pure sibling, where the "never borrow a known colour" rule is unit-tested.
const VERDICT_LABELS: Record<RequirementVerdictStatus, string> = {
  met: t('panels.testReport.requirementVerdicts.met'),
  not_met: t('panels.testReport.requirementVerdicts.notMet'),
  not_covered: t('panels.testReport.requirementVerdicts.notCovered'),
}
function verdictMeta(status: RequirementVerdictStatus): VerdictMeta {
  return resolveVerdictMeta(status, VERDICT_LABELS)
}
</script>

<template>
  <section class="mt-4 scroll-mt-4">
    <div class="mb-2 flex items-center gap-1.5 text-2xs">
      <UIcon name="i-lucide-flask-conical" class="h-3.5 w-3.5 text-muted" />
      <SectionLabel as="span">
        {{ t('panels.testReport.title') }}
      </SectionLabel>
      <UBadge :color="report.greenlight ? 'success' : 'warning'" variant="subtle" size="sm">
        {{
          report.greenlight ? t('panels.testReport.greenlit') : t('panels.testReport.needsFixes')
        }}
      </UBadge>
      <span v-if="phase && phase.attempts > 0" class="text-2xs text-dimmed">
        {{ t('panels.testReport.fixAttempts', { count: phase.attempts, max: phase.maxAttempts })
        }}<span v-if="phase.phase === 'fixing'"> {{ t('panels.testReport.fixing') }}</span>
      </span>
    </div>
    <MarkdownProse
      v-if="report.summary"
      :text="report.summary"
      class="mb-3 text-sm leading-relaxed text-toned"
    />

    <div v-if="report.tested.length" class="mb-3">
      <div class="mb-1 text-2xs text-dimmed">{{ t('panels.testReport.tested') }}</div>
      <ul class="space-y-0.5 text-xs text-toned">
        <li v-for="(item, i) in report.tested" :key="i">• {{ item }}</li>
      </ul>
    </div>

    <div v-if="report.outcomes.length" class="mb-3 space-y-1">
      <div class="text-2xs text-dimmed">{{ t('panels.testReport.outcomes') }}</div>
      <div v-for="(o, i) in report.outcomes" :key="i" class="flex items-start gap-2 text-xs">
        <span
          class="mt-1 h-2 w-2 shrink-0 rounded-full"
          :style="{ backgroundColor: OUTCOME_COLOR[o.status] ?? 'var(--ui-text-muted)' }"
        />
        <span class="text-toned"
          >{{ o.name }}<span v-if="o.detail" class="text-dimmed"> — {{ o.detail }}</span></span
        >
      </div>
    </div>

    <!-- requirement → evidence, in-app twin of the PR verification report's section: which of
         the service's written-down requirements this run actually ruled on, and what it saw -->
    <div
      v-if="report.requirementVerdicts?.length"
      class="mb-3 space-y-1"
      data-testid="test-report-requirement-verdicts"
    >
      <div class="text-2xs text-dimmed">
        {{ t('panels.testReport.requirementVerdicts.title') }}
      </div>
      <div
        v-for="(verdict, i) in report.requirementVerdicts"
        :key="i"
        class="flex items-start gap-2 text-xs"
      >
        <span
          class="mt-1 h-2 w-2 shrink-0 rounded-full"
          :style="{ backgroundColor: verdictMeta(verdict.status).color }"
        />
        <span class="text-toned">
          <span class="font-mono text-2xs text-muted">{{ verdict.requirementId }}</span>
          <span class="text-dimmed"> — {{ verdictMeta(verdict.status).label }}</span>
          <span v-if="verdict.detail" class="text-dimmed"> · {{ verdict.detail }}</span>
        </span>
      </div>
    </div>

    <div v-if="report.concerns.length" class="space-y-1">
      <div class="text-2xs text-dimmed">{{ t('panels.testReport.concerns') }}</div>
      <div
        v-for="(c, i) in report.concerns"
        :key="i"
        class="rounded-sm border border-muted/60 p-2 text-xs"
      >
        <div class="flex items-center gap-1.5">
          <span
            class="rounded-sm px-1 text-3xs font-semibold uppercase text-highlighted"
            :style="{ backgroundColor: SEVERITY_COLOR[c.severity] ?? 'var(--ui-text-muted)' }"
            >{{ c.severity }}</span
          >
          <span class="font-medium text-default">{{ c.title }}</span>
        </div>
        <MarkdownProse v-if="c.detail" :text="c.detail" class="mt-1 text-muted" />
      </div>
    </div>
  </section>
</template>
