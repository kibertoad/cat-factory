<script setup lang="ts">
// The initiative tracker window — the dedicated read-only view of an initiative's
// plan/tracker entity: goal + constraints, the phases with their per-item status +
// PR links, the execution policy, and the decisions / deviations / follow-ups /
// caveats logs. Renders the DB entity (the source of truth) — never the in-repo
// mirror, which may not exist (GitHub-unwired workspaces). Opened via the universal
// result-view host: from the board card / inspector (`ui.openInitiativeTracker`) or
// as the planner step's result view. Live `initiative` stream events patch the
// store, so an open window follows the plan as it is ingested and later executed.
import { computed } from 'vue'
import type { InitiativeItem } from '~/types/domain'
import {
  INITIATIVE_ITEM_STATUS_CHIPS,
  INITIATIVE_ITEM_STATUS_LABEL_KEYS,
  INITIATIVE_STATUS_LABEL_KEYS,
  initiativeProgress,
} from '~/utils/initiative'

const board = useBoardStore()
const initiatives = useInitiativesStore()
const { t } = useI18n()

const { open, blockId, close } = useResultView('initiative-tracker', {
  onOpen: (id) => void initiatives.load(id),
})

const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const initiative = computed(() => (blockId.value ? initiatives.forBlock(blockId.value) : null))

const phases = computed(() => initiative.value?.phases ?? [])
function itemsOf(phaseId: string): InitiativeItem[] {
  return (initiative.value?.items ?? []).filter((i) => i.phaseId === phaseId)
}

const progress = computed(() => initiativeProgress(initiative.value?.items))
const progressPct = computed(() =>
  progress.value && progress.value.total > 0
    ? Math.round((progress.value.settled / progress.value.total) * 100)
    : 0,
)

const policyRules = computed(() => initiative.value?.policy?.rules ?? [])
function ruleAxes(rule: { minComplexity?: number; minRisk?: number; minImpact?: number }): string {
  const axes = [
    rule.minComplexity !== undefined
      ? t('initiative.tracker.axisComplexity', { value: rule.minComplexity })
      : null,
    rule.minRisk !== undefined ? t('initiative.tracker.axisRisk', { value: rule.minRisk }) : null,
    rule.minImpact !== undefined
      ? t('initiative.tracker.axisImpact', { value: rule.minImpact })
      : null,
  ].filter((a): a is string => a !== null)
  return axes.length ? axes.join(' · ') : t('initiative.tracker.axisNever')
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex max-h-[100dvh] items-stretch justify-center bg-slate-950/70 backdrop-blur-sm"
      @click.self="close"
    >
      <div
        class="m-4 flex w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl"
        role="dialog"
        aria-modal="true"
        data-testid="initiative-tracker-window"
      >
        <!-- Header -->
        <header class="flex items-center gap-3 border-b border-slate-800 px-5 py-3">
          <span
            class="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-300"
          >
            <UIcon name="i-lucide-milestone" class="h-4 w-4" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="truncate text-sm font-semibold text-slate-100">
              {{ initiative?.title ?? block?.title ?? t('initiative.tracker.title') }}
            </h2>
            <p class="truncate text-[11px] text-slate-400">
              {{ t('initiative.tracker.subtitle') }}
            </p>
          </div>
          <div v-if="progress" class="flex items-center gap-2" data-testid="initiative-progress">
            <div class="h-1.5 w-24 overflow-hidden rounded-full bg-slate-800">
              <div
                class="h-full rounded-full bg-emerald-500 transition-[width] duration-500"
                :style="{ width: `${progressPct}%` }"
              />
            </div>
            <span class="text-[11px] tabular-nums text-slate-400">
              {{ t('initiative.card.progress', { done: progress.settled, total: progress.total }) }}
            </span>
          </div>
          <UBadge v-if="initiative" color="primary" variant="subtle" size="sm">
            {{ t(INITIATIVE_STATUS_LABEL_KEYS[initiative.status]) }}
          </UBadge>
          <button
            class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            @click="close"
          >
            <UIcon name="i-lucide-x" class="h-4 w-4" />
          </button>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <!-- No entity yet (module unwired / still creating) -->
          <div
            v-if="!initiative"
            class="flex h-full flex-col items-center justify-center gap-2 text-center text-slate-400"
          >
            <UIcon name="i-lucide-milestone" class="h-8 w-8 opacity-40" />
            <p class="text-sm">{{ t('initiative.tracker.empty') }}</p>
          </div>

          <template v-else>
            <!-- Goal & constraints -->
            <section v-if="initiative.goal" class="mb-4">
              <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('initiative.tracker.goal') }}
              </h3>
              <p class="whitespace-pre-wrap text-[13px] leading-relaxed text-slate-300">
                {{ initiative.goal }}
              </p>
            </section>
            <section v-if="initiative.constraints?.length" class="mb-4">
              <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('initiative.tracker.constraints') }}
              </h3>
              <ul class="list-inside list-disc text-[13px] text-slate-300">
                <li v-for="(c, i) in initiative.constraints" :key="i">{{ c }}</li>
              </ul>
            </section>
            <section v-if="initiative.nonGoals?.length" class="mb-4">
              <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('initiative.tracker.nonGoals') }}
              </h3>
              <ul class="list-inside list-disc text-[13px] text-slate-300">
                <li v-for="(g, i) in initiative.nonGoals" :key="i">{{ g }}</li>
              </ul>
            </section>
            <section v-if="initiative.analysisSummary" class="mb-4">
              <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('initiative.tracker.analysis') }}
              </h3>
              <p class="whitespace-pre-wrap text-[13px] leading-relaxed text-slate-300">
                {{ initiative.analysisSummary }}
              </p>
            </section>

            <!-- Awaiting planning -->
            <div
              v-if="phases.length === 0"
              class="mb-4 rounded-lg border border-dashed border-slate-700 p-4 text-center text-[12px] text-slate-400"
            >
              {{ t('initiative.tracker.noPlan') }}
            </div>

            <!-- Phases + items -->
            <section v-for="phase in phases" :key="phase.id" class="mb-5">
              <h3 class="mb-1 text-sm font-semibold text-slate-200">
                {{ t('initiative.tracker.phase', { title: phase.title }) }}
              </h3>
              <p v-if="phase.goal" class="mb-2 text-[12px] text-slate-400">{{ phase.goal }}</p>
              <div class="overflow-x-auto rounded-lg border border-slate-800">
                <table class="w-full text-[12px]">
                  <thead>
                    <tr class="border-b border-slate-800 text-left text-slate-500">
                      <th class="px-3 py-2 font-medium">{{ t('initiative.tracker.colItem') }}</th>
                      <th class="px-3 py-2 font-medium">{{ t('initiative.tracker.colStatus') }}</th>
                      <th class="px-3 py-2 font-medium">{{ t('initiative.tracker.colPr') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="item in itemsOf(phase.id)"
                      :key="item.id"
                      class="border-b border-slate-800/60 last:border-0"
                    >
                      <td class="px-3 py-2 align-top">
                        <div class="font-medium text-slate-200">{{ item.title }}</div>
                        <div
                          v-if="item.dependsOn?.length"
                          class="mt-0.5 text-[10px] text-slate-500"
                        >
                          {{
                            t('initiative.tracker.dependsOn', {
                              items: item.dependsOn.join(', '),
                            })
                          }}
                        </div>
                        <div v-if="item.note" class="mt-0.5 text-[10px] text-amber-300/80">
                          {{ item.note }}
                        </div>
                      </td>
                      <td class="px-3 py-2 align-top">
                        <UBadge
                          :color="INITIATIVE_ITEM_STATUS_CHIPS[item.status] as any"
                          variant="subtle"
                          size="sm"
                        >
                          {{ t(INITIATIVE_ITEM_STATUS_LABEL_KEYS[item.status]) }}
                        </UBadge>
                      </td>
                      <td class="px-3 py-2 align-top">
                        <a
                          v-if="item.pr"
                          :href="item.pr.url"
                          target="_blank"
                          rel="noopener"
                          class="text-sky-400 hover:underline"
                        >
                          {{
                            item.pr.number ? `#${item.pr.number}` : t('initiative.tracker.prLink')
                          }}
                        </a>
                        <span v-else class="text-slate-600">—</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <!-- Execution policy -->
            <section v-if="initiative.policy" class="mb-4">
              <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('initiative.tracker.policy') }}
              </h3>
              <ul class="text-[12px] text-slate-300">
                <li>
                  {{
                    t('initiative.tracker.maxConcurrent', {
                      count: initiative.policy.maxConcurrent,
                    })
                  }}
                </li>
                <li v-for="(rule, i) in policyRules" :key="i">
                  <code class="text-sky-300">{{ rule.pipelineId }}</code>
                  · {{ ruleAxes(rule) }}
                </li>
                <li>
                  {{ t('initiative.tracker.defaultPipeline') }}
                  <code class="text-sky-300">{{ initiative.policy.defaultPipelineId }}</code>
                </li>
              </ul>
            </section>

            <!-- Logs -->
            <section v-if="initiative.decisions?.length" class="mb-4">
              <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('initiative.tracker.decisions') }}
              </h3>
              <ul class="list-inside list-disc text-[13px] text-slate-300">
                <li v-for="d in initiative.decisions" :key="d.id">
                  <span class="font-medium">{{ d.title }}</span>
                  <span v-if="d.detail" class="text-slate-400"> — {{ d.detail }}</span>
                </li>
              </ul>
            </section>
            <section v-if="initiative.deviations?.length" class="mb-4">
              <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('initiative.tracker.deviations') }}
              </h3>
              <ul class="list-inside list-disc text-[13px] text-slate-300">
                <li v-for="d in initiative.deviations" :key="d.id">
                  <code v-if="d.itemId" class="text-slate-400">{{ d.itemId }}</code>
                  {{ d.description }}
                  <span v-if="d.resolution" class="text-slate-400"> → {{ d.resolution }}</span>
                </li>
              </ul>
            </section>
            <section v-if="initiative.followUps?.length" class="mb-4">
              <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('initiative.tracker.followUps') }}
              </h3>
              <ul class="list-inside list-disc text-[13px] text-slate-300">
                <li v-for="f in initiative.followUps" :key="f.id">
                  <span class="font-medium">{{ f.title }}</span>
                  <span v-if="f.detail" class="text-slate-400"> — {{ f.detail }}</span>
                </li>
              </ul>
            </section>
            <section v-if="initiative.caveats?.length" class="mb-4">
              <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('initiative.tracker.caveats') }}
              </h3>
              <ul class="list-inside list-disc text-[13px] text-slate-300">
                <li v-for="(c, i) in initiative.caveats" :key="i">{{ c }}</li>
              </ul>
            </section>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>
