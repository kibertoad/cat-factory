<script setup lang="ts">
import type { TestReport } from '~/types/domain'
import type { TesterStepState } from '~/types/execution'

// A tester step's latest structured report (what was tested, the per-area outcomes,
// the concerns it raised and the greenlight verdict) plus the fixer-loop phase.
defineProps<{
  report: TestReport
  phase: TesterStepState | null
}>()

const SEVERITY_COLOR: Record<string, string> = {
  low: '#64748b',
  medium: '#f59e0b',
  high: '#f97316',
  critical: '#ef4444',
}
const OUTCOME_COLOR: Record<string, string> = {
  passed: '#22c55e',
  failed: '#ef4444',
  skipped: '#64748b',
}
</script>

<template>
  <section class="mt-4 scroll-mt-4">
    <div class="mb-2 flex items-center gap-1.5 text-[11px]">
      <UIcon name="i-lucide-flask-conical" class="h-3.5 w-3.5 text-slate-400" />
      <span class="font-semibold uppercase tracking-wide text-slate-400"> Test report </span>
      <UBadge :color="report.greenlight ? 'success' : 'warning'" variant="subtle" size="sm">
        {{ report.greenlight ? 'Greenlit' : 'Needs fixes' }}
      </UBadge>
      <span v-if="phase && phase.attempts > 0" class="text-[11px] text-slate-500">
        {{ phase.attempts }}/{{ phase.maxAttempts }} fix attempt(s)<span
          v-if="phase.phase === 'fixing'"
        >
          · fixing…</span
        >
      </span>
    </div>
    <p v-if="report.summary" class="mb-3 text-[13px] leading-relaxed text-slate-300">
      {{ report.summary }}
    </p>

    <div v-if="report.tested.length" class="mb-3">
      <div class="mb-1 text-[11px] text-slate-500">Tested</div>
      <ul class="space-y-0.5 text-[12px] text-slate-300">
        <li v-for="(t, i) in report.tested" :key="i">• {{ t }}</li>
      </ul>
    </div>

    <div v-if="report.outcomes.length" class="mb-3 space-y-1">
      <div class="text-[11px] text-slate-500">Outcomes</div>
      <div v-for="(o, i) in report.outcomes" :key="i" class="flex items-start gap-2 text-[12px]">
        <span
          class="mt-1 h-2 w-2 shrink-0 rounded-full"
          :style="{ backgroundColor: OUTCOME_COLOR[o.status] ?? '#64748b' }"
        />
        <span class="text-slate-300"
          >{{ o.name }}<span v-if="o.detail" class="text-slate-500"> — {{ o.detail }}</span></span
        >
      </div>
    </div>

    <div v-if="report.concerns.length" class="space-y-1">
      <div class="text-[11px] text-slate-500">Concerns</div>
      <div
        v-for="(c, i) in report.concerns"
        :key="i"
        class="rounded border border-slate-700/60 p-2 text-[12px]"
      >
        <div class="flex items-center gap-1.5">
          <span
            class="rounded px-1 text-[10px] font-semibold uppercase text-white"
            :style="{ backgroundColor: SEVERITY_COLOR[c.severity] ?? '#64748b' }"
            >{{ c.severity }}</span
          >
          <span class="font-medium text-slate-200">{{ c.title }}</span>
        </div>
        <p v-if="c.detail" class="mt-1 text-slate-400">{{ c.detail }}</p>
      </div>
    </div>
  </section>
</template>
