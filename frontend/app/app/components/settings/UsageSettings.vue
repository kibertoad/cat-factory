<script setup lang="ts">
// The Usage report: token usage this billing period, broken down into flat-rate
// subscription harness usage (Claude Code / Codex / GLM / pooled Kimi & DeepSeek) and
// metered API/proxy calls. Reporting only — the spend budget (Budget tab) still counts
// only the metered rows. See docs/initiatives/usage-and-quota-tracking.md.
import { computed, watch } from 'vue'
import type { UsageBreakdownRow } from '@cat-factory/contracts'

const { t, n, d } = useI18n()
const usage = useUsageStore()
const workspace = useWorkspaceStore()

// Load (and reload) whenever the active workspace resolves/changes.
watch(
  () => workspace.workspaceId,
  (ws) => {
    if (ws) usage.load(ws)
  },
  { immediate: true },
)

const currency = computed(() => usage.report?.currency ?? 'EUR')
const money = (value: number) => n(value, { key: 'currency', currency: currency.value })

// The largest single-row token total in a section, so the per-row bars are relative to the
// section's heaviest model (a full bar = the biggest consumer, not an absolute quota).
function maxTokens(rows: UsageBreakdownRow[]): number {
  return rows.reduce((m, r) => Math.max(m, r.inputTokens + r.outputTokens), 0)
}
function pctOf(row: UsageBreakdownRow, rows: UsageBreakdownRow[]): number {
  const max = maxTokens(rows)
  if (max <= 0) return 0
  return Math.round(((row.inputTokens + row.outputTokens) / max) * 100)
}

const hasAny = computed(() => usage.rows.length > 0)
</script>

<template>
  <div class="space-y-6">
    <p class="text-[11px] text-slate-400">
      {{ t('settings.usage.body') }}
    </p>

    <p v-if="usage.report" class="text-[11px] text-slate-500">
      {{ t('settings.usage.period', { date: d(new Date(usage.report.periodStart), 'short') }) }}
    </p>

    <p v-if="usage.loading" class="text-[11px] text-slate-500">{{ t('common.loading') }}</p>
    <p v-else-if="usage.error" class="text-[11px] text-rose-400">{{ usage.error }}</p>
    <p v-else-if="!hasAny" class="text-[11px] text-slate-500">{{ t('settings.usage.empty') }}</p>

    <template v-else>
      <!-- Subscriptions (flat-rate quota harnesses) -->
      <section v-if="usage.subscription.length" class="space-y-3">
        <div class="flex items-baseline justify-between">
          <h3 class="text-sm font-semibold text-slate-200">
            {{ t('settings.usage.subscription') }}
          </h3>
          <span class="text-[11px] text-slate-400">
            {{
              t('settings.usage.tokens', {
                input: formatTokens(usage.subscriptionTotal.inputTokens),
                output: formatTokens(usage.subscriptionTotal.outputTokens),
              })
            }}
          </span>
        </div>
        <p class="text-[10px] text-slate-500">{{ t('settings.usage.illustrative') }}</p>
        <div
          v-for="row in usage.subscription"
          :key="`sub-${row.vendor}-${row.provider}-${row.model}`"
          class="space-y-1"
          :data-testid="'usage-row-subscription'"
        >
          <div class="flex items-center justify-between gap-2 text-[11px]">
            <span class="min-w-0 truncate font-medium text-slate-300">{{ row.model }}</span>
            <span class="shrink-0 rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] text-slate-300">
              {{ row.vendor ?? row.provider }}
            </span>
          </div>
          <UProgress :model-value="pctOf(row, usage.subscription)" size="xs" color="primary" />
          <div class="flex justify-between text-[10px] text-slate-500">
            <span>
              {{
                t('settings.usage.tokens', {
                  input: formatTokens(row.inputTokens),
                  output: formatTokens(row.outputTokens),
                })
              }}
              · {{ t('settings.usage.calls', { count: row.calls }) }}
            </span>
            <span>~{{ money(row.costEstimate) }}</span>
          </div>
        </div>
      </section>

      <!-- Metered API / proxy calls (real spend) -->
      <section v-if="usage.metered.length" class="space-y-3">
        <div class="flex items-baseline justify-between">
          <h3 class="text-sm font-semibold text-slate-200">
            {{ t('settings.usage.metered') }}
          </h3>
          <span class="text-[11px] text-slate-400">
            {{
              t('settings.usage.tokens', {
                input: formatTokens(usage.meteredTotal.inputTokens),
                output: formatTokens(usage.meteredTotal.outputTokens),
              })
            }}
            · {{ money(usage.meteredTotal.costEstimate) }}
          </span>
        </div>
        <div
          v-for="row in usage.metered"
          :key="`met-${row.provider}-${row.model}`"
          class="space-y-1"
          :data-testid="'usage-row-metered'"
        >
          <div class="flex items-center justify-between gap-2 text-[11px]">
            <span class="min-w-0 truncate font-medium text-slate-300">
              {{ row.provider }}:{{ row.model }}
            </span>
          </div>
          <UProgress :model-value="pctOf(row, usage.metered)" size="xs" color="neutral" />
          <div class="flex justify-between text-[10px] text-slate-500">
            <span>
              {{
                t('settings.usage.tokens', {
                  input: formatTokens(row.inputTokens),
                  output: formatTokens(row.outputTokens),
                })
              }}
              · {{ t('settings.usage.calls', { count: row.calls }) }}
            </span>
            <span>{{ money(row.costEstimate) }}</span>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
