<script setup lang="ts">
// Dedicated result view for a completed `merger` step. The merger agent scores the PR
// (complexity / risk / impact + a rationale) and the engine records its structured
// decision on the step (`step.custom`, a `MergeDecision`): whether it auto-merged or
// routed the PR to a human, and WHY. This renders that verdict — the three scores as
// bars against their preset ceilings, the rationale, and a plain-language decision
// banner — instead of the agent's raw JSON. Opened via the universal result-view host,
// the same seam the requirements / tester windows use.
import { computed } from 'vue'
import type { MergeAxis, MergeDecision } from '@cat-factory/contracts'
import StepRunMeta from '~/components/panels/StepRunMeta.vue'
import StepRestartControl from '~/components/panels/StepRestartControl.vue'

const board = useBoardStore()
const execution = useExecutionStore()
const agents = useAgentsStore()
const { t, n } = useI18n()

// Shared seam contract (open/blockId/close + Escape). No loader: the verdict is read
// straight off the execution step.
const { open, blockId, instanceId, stepIndex, close } = useResultView('merger')
const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))

const instance = computed(() =>
  instanceId.value === null ? null : (execution.getInstance(instanceId.value) ?? null),
)
const step = computed(() => {
  if (instance.value === null || stepIndex.value === null) return null
  return instance.value.steps[stepIndex.value] ?? null
})
const meta = computed(() => (step.value ? agents.get(step.value.agentKind) : undefined))

const headerLabel = computed(() => meta.value?.label ?? t('panels.mergerResult.title'))
const headerTitle = computed(() =>
  block.value
    ? t('panels.mergerResult.titleWithBlock', { title: block.value.title })
    : headerLabel.value,
)

/** The engine's structured verdict; null for a step that predates the structured decision. */
const decision = computed<MergeDecision | null>(() => {
  const custom = step.value?.custom
  return custom && typeof custom === 'object' && 'outcome' in custom
    ? (custom as MergeDecision)
    : null
})

const merged = computed(() => decision.value?.outcome === 'auto_merged')
// Only redden bars when a threshold breach is the ACTUAL reason for review. For
// `auto_merge_disabled` / `no_rationale` / `no_assessment` a score above its ceiling is
// incidental, so it must not imply the axis is what caused the review.
const exceeded = computed(() =>
  decision.value?.reason === 'exceeded_thresholds'
    ? new Set<MergeAxis>(decision.value.exceededAxes)
    : new Set<MergeAxis>(),
)

// Exhaustive enum → i18n-key maps keyed off the contract unions, so adding a new
// `MergeDecision` reason/outcome (or a merge axis) fails typecheck here until its key is
// added — the drift guard the dynamic `t(\`...\${x}\`)` lookups can't provide on their own.
const REASON_KEYS: Record<MergeDecision['reason'], string> = {
  within_thresholds: 'panels.mergerResult.reason.within_thresholds',
  exceeded_thresholds: 'panels.mergerResult.reason.exceeded_thresholds',
  auto_merge_disabled: 'panels.mergerResult.reason.auto_merge_disabled',
  no_rationale: 'panels.mergerResult.reason.no_rationale',
  no_assessment: 'panels.mergerResult.reason.no_assessment',
  merge_failed: 'panels.mergerResult.reason.merge_failed',
  merge_partial: 'panels.mergerResult.reason.merge_partial',
}
const OUTCOME_KEYS: Record<MergeDecision['outcome'], string> = {
  auto_merged: 'panels.mergerResult.outcome.auto_merged',
  awaiting_review: 'panels.mergerResult.outcome.awaiting_review',
}
const AXIS_KEYS: Record<MergeAxis, string> = {
  complexity: 'panels.mergerResult.axis.complexity',
  risk: 'panels.mergerResult.axis.risk',
  impact: 'panels.mergerResult.axis.impact',
}

const outcomeText = computed(() => (decision.value ? t(OUTCOME_KEYS[decision.value.outcome]) : ''))

/** The three axes with their score + preset ceiling, for the bar rows. */
const axes = computed(() => {
  const d = decision.value
  if (!d?.assessment) return []
  return [
    {
      key: 'complexity' as const,
      label: t(AXIS_KEYS.complexity),
      score: d.assessment.complexity,
      ceiling: d.thresholds.maxComplexity,
    },
    {
      key: 'risk' as const,
      label: t(AXIS_KEYS.risk),
      score: d.assessment.risk,
      ceiling: d.thresholds.maxRisk,
    },
    {
      key: 'impact' as const,
      label: t(AXIS_KEYS.impact),
      score: d.assessment.impact,
      ceiling: d.thresholds.maxImpact,
    },
  ]
})

/** The plain-language "why" line, interpolating the preset + any exceeded axes. */
const reasonText = computed(() => {
  const d = decision.value
  if (!d) return ''
  const axisLabels = d.exceededAxes.map((a) => t(AXIS_KEYS[a])).join(', ')
  return t(REASON_KEYS[d.reason], {
    preset: d.thresholds.presetName,
    axes: axisLabels,
  })
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex max-h-[100dvh] items-stretch justify-center bg-slate-950/70 backdrop-blur-sm"
      @click.self="close"
    >
      <div
        class="m-4 flex w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl"
      >
        <!-- Header -->
        <header class="flex items-center gap-3 border-b border-slate-800 px-5 py-3">
          <span
            class="flex h-8 w-8 items-center justify-center rounded-lg bg-lime-500/15 text-lime-300"
          >
            <UIcon :name="meta?.icon ?? 'i-lucide-git-pull-request'" class="h-4 w-4" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="truncate text-sm font-semibold text-slate-100">{{ headerTitle }}</h2>
            <p class="truncate text-[11px] text-slate-400">
              {{ t('panels.mergerResult.description') }}
            </p>
          </div>
          <StepRestartControl
            :instance-id="instanceId"
            :step-index="stepIndex"
            @restarted="close"
          />
          <button
            class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            @click="close"
          >
            <UIcon name="i-lucide-x" class="h-4 w-4" />
          </button>
        </header>

        <div class="flex min-h-0 flex-1">
          <div class="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            <template v-if="decision">
              <!-- Decision banner: auto-merged (success) vs awaiting human review (warning). -->
              <div
                class="mb-4 flex items-start gap-3 rounded-lg border p-3"
                :class="
                  merged
                    ? 'border-emerald-800/70 bg-emerald-500/10'
                    : 'border-amber-800/70 bg-amber-500/10'
                "
                data-testid="merger-decision"
                :data-outcome="decision.outcome"
              >
                <UIcon
                  :name="merged ? 'i-lucide-git-merge' : 'i-lucide-user-round-check'"
                  class="mt-0.5 h-5 w-5 shrink-0"
                  :class="merged ? 'text-emerald-300' : 'text-amber-300'"
                />
                <div class="min-w-0">
                  <p
                    class="text-sm font-semibold"
                    :class="merged ? 'text-emerald-200' : 'text-amber-200'"
                  >
                    {{ outcomeText }}
                  </p>
                  <p class="mt-0.5 text-[13px] leading-relaxed text-slate-300">{{ reasonText }}</p>
                </div>
              </div>

              <!-- Scores vs the resolved preset's ceilings. -->
              <template v-if="axes.length">
                <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {{ t('panels.mergerResult.scores') }}
                </h3>
                <div class="space-y-2 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                  <div v-for="axis in axes" :key="axis.key" class="flex items-center gap-2">
                    <span class="w-20 shrink-0 text-xs text-slate-400">{{ axis.label }}</span>
                    <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
                      <div
                        class="h-full rounded-full"
                        :class="exceeded.has(axis.key) ? 'bg-rose-500' : 'bg-emerald-500'"
                        :style="{ width: `${Math.round(axis.score * 100)}%` }"
                      />
                    </div>
                    <span
                      class="w-11 shrink-0 text-end text-xs tabular-nums"
                      :class="exceeded.has(axis.key) ? 'text-rose-300' : 'text-slate-300'"
                    >
                      {{ n(axis.score, { key: 'percent' }) }}
                    </span>
                    <span class="w-24 shrink-0 text-end text-[10px] tabular-nums text-slate-500">
                      {{
                        t('panels.mergerResult.ceiling', {
                          value: n(axis.ceiling, { key: 'percent' }),
                        })
                      }}
                    </span>
                  </div>
                </div>
              </template>

              <!-- The agent's prose justification. -->
              <template v-if="decision.assessment?.rationale">
                <h3
                  class="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-500"
                >
                  {{ t('panels.mergerResult.rationale') }}
                </h3>
                <p class="whitespace-pre-wrap text-[13px] leading-relaxed text-slate-300">
                  {{ decision.assessment.rationale }}
                </p>
              </template>
              <p v-else class="text-[13px] italic leading-relaxed text-slate-500">
                {{ t('panels.mergerResult.noAssessment') }}
              </p>
            </template>

            <!-- Pre-structured runs kept only the raw prose output. -->
            <p
              v-else-if="step?.output"
              class="whitespace-pre-wrap text-[13px] leading-relaxed text-slate-300"
            >
              {{ step.output }}
            </p>
            <div
              v-else
              class="flex h-full flex-col items-center justify-center gap-2 text-center text-slate-400"
            >
              <UIcon name="i-lucide-git-pull-request" class="h-8 w-8 opacity-40" />
              <p class="text-sm">{{ t('panels.mergerResult.noResult') }}</p>
            </div>
          </div>

          <!-- Sidebar: shared run metadata. -->
          <aside
            class="hidden w-60 shrink-0 flex-col gap-4 border-s border-slate-800 bg-slate-900/50 px-4 py-4 lg:flex"
          >
            <StepRunMeta
              v-if="step"
              :step="step"
              :instance-id="instanceId ?? undefined"
              :step-number="stepIndex === null ? undefined : stepIndex + 1"
              :total-steps="instance?.steps.length"
              :run-failed="instance?.status === 'failed'"
              :failure-at="instance?.failure?.occurredAt"
            />
          </aside>
        </div>
      </div>
    </div>
  </Teleport>
</template>
