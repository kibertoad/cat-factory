<script setup lang="ts">
// Generic structured-result window — the default dedicated surface for a registered
// CUSTOM agent kind whose archetype declares `resultView: 'generic-structured'`. A custom
// `container-explore` agent returns structured JSON (the engine's `custom` channel), which
// is recorded on the step; this renders it read-only (pretty-printed JSON), alongside the
// agent's prose summary and the shared run metadata — so a proprietary kind ships a usable
// result view with ZERO bespoke frontend code. Opened via the universal result-view host,
// the same seam the requirements / tester windows use.
import { computed } from 'vue'
import StepRunMeta from '~/components/panels/StepRunMeta.vue'
import ResultWindowShell from '~/components/panels/ResultWindowShell.vue'
import MarkdownProse from '~/components/common/MarkdownProse.vue'
import CopyButton from '~/components/common/CopyButton.vue'

const board = useBoardStore()
const execution = useExecutionStore()
const agents = useAgentsStore()
const { t } = useI18n()

// Shared seam contract (open/blockId/close). No `onOpen` loader: this window reads its data
// straight off the execution step, so there's nothing to fetch on open. `ResultWindowShell`
// owns Escape (and focus trap + scroll lock + stacking).
const { open, blockId, instanceId, stepIndex, close } = useResultView('generic-structured')
const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))

const instance = computed(() =>
  instanceId.value === null ? null : (execution.getInstance(instanceId.value) ?? null),
)
const step = computed(() => {
  if (instance.value === null || stepIndex.value === null) return null
  return instance.value.steps[stepIndex.value] ?? null
})
const meta = computed(() => (step.value ? agents.get(step.value.agentKind) : undefined))

const headerLabel = computed(() => meta.value?.label ?? t('panels.structuredResult.fallbackTitle'))
const headerTitle = computed(() =>
  block.value
    ? t('panels.structuredResult.titleWithBlock', {
        label: headerLabel.value,
        title: block.value.title,
      })
    : headerLabel.value,
)

/** The agent's structured JSON, pretty-printed; null when the step produced none. */
const customJson = computed<string | null>(() => {
  const custom = step.value?.custom
  if (custom === undefined || custom === null) return null
  try {
    return JSON.stringify(custom, null, 2)
  } catch {
    return String(custom)
  }
})
</script>

<template>
  <ResultWindowShell
    :open="open"
    :icon="meta?.icon ?? 'i-lucide-braces'"
    icon-class="bg-cyan-500/15 text-cyan-300"
    :title="headerTitle"
    :subtitle="meta?.description ?? t('panels.structuredResult.fallbackDescription')"
    :step-ref="{ instanceId, stepIndex }"
    width="4xl"
    @close="close"
  >
    <div class="flex min-h-0 flex-1">
      <!-- Main: prose summary + structured JSON -->
      <div class="min-w-0 flex-1 overflow-y-auto px-5 py-4">
        <MarkdownProse
          v-if="step?.output"
          :text="step.output"
          class="mb-4 text-[13px] leading-relaxed text-slate-300"
        />

        <template v-if="customJson">
          <div class="mb-2 flex items-center gap-2">
            <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              {{ t('panels.structuredResult.structuredOutput') }}
            </h3>
            <CopyButton :text="customJson" class="-my-1" />
          </div>
          <pre
            class="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-[12px] leading-relaxed text-slate-200"
          ><code>{{ customJson }}</code></pre>
        </template>

        <div
          v-else-if="!step?.output"
          class="flex h-full flex-col items-center justify-center gap-2 text-center text-slate-400"
        >
          <UIcon name="i-lucide-braces" class="h-8 w-8 opacity-40" />
          <p class="text-sm">{{ t('panels.structuredResult.noResult') }}</p>
          <p class="max-w-sm text-[11px] text-slate-500">
            {{ t('panels.structuredResult.noResultHint') }}
          </p>
        </div>
      </div>

      <!-- Sidebar: shared run metadata + observability rollup -->
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
  </ResultWindowShell>
</template>
