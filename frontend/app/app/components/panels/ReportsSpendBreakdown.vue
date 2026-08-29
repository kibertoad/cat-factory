<script setup lang="ts">
import { computed } from 'vue'
import type { ReportSpendCap, ReportSpendRow } from '~/types/execution'
import { maxOf, segmentPct, spendMagnitude } from './ReportsPanel.logic'

// One ranked spend breakdown: a horizontal bar per slice, split into the metered
// (`violet-500`, real money) and subscription (`amber-600`, illustrative equivalent-API
// cost) segments with a surface gap between them. Extracted from `ReportsPanel.vue` because
// the panel renders four of these against different dimensions — the shape is identical,
// only the row list and the heading differ.
//
// Every bar is scaled against the HEAVIEST slice in this list, so a full bar means "the
// biggest consumer here", never an absolute budget. The panel owns the legend (the two
// series mean the same thing in every breakdown, so repeating it per card would be noise).
const props = defineProps<{
  rows: ReportSpendRow[]
  currency: string
  testId: string
  /** Resolves a slice's display name (the panel owns the unattributed/i18n vocabulary). */
  labelOf: (row: ReportSpendRow) => string
  /**
   * What this breakdown left out, when the projection capped it. Rendered as a footer note:
   * a reader who assumes a list is complete would read the heaviest hundred repositories as
   * the whole bill, so the tail is STATED rather than left to be inferred from the row count.
   * The window totals above still cover it, which is what the note says.
   */
  cap?: ReportSpendCap | null
}>()

const { t, n } = useI18n()
const money = (value: number) => n(value, { key: 'currency', currency: props.currency })
const max = computed(() => maxOf(props.rows, spendMagnitude))
</script>

<template>
  <div class="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
    <div v-if="!rows.length" class="py-4 text-center text-xs text-slate-500">
      {{ t('reports.spend.empty') }}
    </div>
    <ul v-else class="flex flex-col gap-2.5" :data-testid="testId">
      <li v-for="row in rows" :key="row.key" class="text-xs" data-testid="reports-spend-row">
        <div class="mb-1 flex items-baseline justify-between gap-2">
          <span class="min-w-0 truncate text-slate-300">{{ labelOf(row) }}</span>
          <!-- The metered figure alone is the slice's SPEND. The subscription cost rides
               beside it, in its own series colour and explicitly named, because it is the
               illustrative cost of flat-rate quota usage — adding the two into one currency
               figure would report money that was never billed. -->
          <span class="shrink-0 tabular-nums text-slate-400">
            {{ money(row.meteredCost) }}
            <span
              v-if="row.subscriptionCost > 0"
              class="text-amber-400"
              :title="t('reports.legend.subscriptionHint')"
            >
              {{ t('reports.spend.subscriptionAside', { value: money(row.subscriptionCost) }) }}
            </span>
          </span>
        </div>
        <div class="flex h-1.5 gap-[2px]">
          <div
            class="h-1.5 rounded-full bg-violet-500"
            :style="{ width: `${segmentPct(row.meteredCost, max)}%` }"
          />
          <div
            class="h-1.5 rounded-full bg-amber-600"
            :style="{ width: `${segmentPct(row.subscriptionCost, max)}%` }"
          />
        </div>
        <p class="mt-1 text-[10px] text-slate-500">
          {{ t('reports.spend.calls', { count: row.calls }, row.calls) }} ·
          {{
            t('reports.spend.tokens', {
              input: formatTokens(row.inputTokens),
              output: formatTokens(row.outputTokens),
            })
          }}
        </p>
      </li>
    </ul>
    <p v-if="cap" class="mt-3 text-[10px] text-slate-500" data-testid="reports-spend-capped">
      {{ t('reports.spend.capped', { shown: n(cap.returned), omitted: n(cap.omitted) }) }}
    </p>
  </div>
</template>
