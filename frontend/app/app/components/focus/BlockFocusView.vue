<script setup lang="ts">
import { onKeyStroke } from '@vueuse/core'
import type { Block } from '~/types/domain'
import { blockTypeMeta, STATUS_META } from '~/utils/catalog'
import { pipelineAllowedForManualStart } from '~/utils/pipeline'
import PipelineProgress from '~/components/pipeline/PipelineProgress.vue'
import IconButton from '~/components/common/IconButton.vue'
import { useInitiativePlanning } from '~/composables/useInitiativePlanning'

const board = useBoardStore()
const pipelines = usePipelinesStore()
const execution = useExecutionStore()
const ui = useUiStore()
const models = useModelsStore()
const workspace = useWorkspaceStore()

const { t, n } = useI18n()

onMounted(() => models.ensureLoaded(workspace.workspaceId ?? undefined))

const block = computed<Block | undefined>(() =>
  ui.focusBlockId ? board.getBlock(ui.focusBlockId) : undefined,
)
const instance = computed(() => execution.getInstance(block.value?.executionId))
const statusMeta = computed(() => (block.value ? STATUS_META[block.value.status] : null))
const typeMeta = computed(() => (block.value ? blockTypeMeta(block.value.type) : null))

const deps = computed(() =>
  (block.value?.dependsOn ?? []).map((id) => board.getBlock(id)).filter((b): b is Block => !!b),
)

// Hide UI-testing pipelines when this block's frame has no UI to exercise, `'recurring'`-only
// pipelines (a manual run of one is refused server-side), and every pipeline whose purpose doesn't
// match this block's task type or LEVEL (per the `purpose` classifier) — see the backend gate. The
// level is what keeps the planning presets on initiative blocks and off everything else, in both
// directions, so this menu never offers a run the engine answers with a 409.
const runOptions = computed(() => {
  const frame = block.value ? board.serviceOf(block.value) : undefined
  return pipelines.pipelines.filter((p) =>
    pipelineAllowedForManualStart(
      p,
      frame,
      board.blocks,
      block.value?.taskType,
      block.value?.level,
    ),
  )
})

// The run MODE, shared with the inspector's Run menu so the two surfaces offer (and force) the
// same thing. The toggle sits beside the picker rather than inside it because the picker's rows
// START a run on click: a modifier reachable only by opening the list would be one the user has
// to arm and re-open the menu to use.
const runStart = useRunStart(() => block.value?.id)

/** Start the picked pipeline immediately — the Run menu chooses an ACTION, it stores no default. */
function runPipeline(id: string) {
  const pipeline = pipelines.getPipeline(id)
  if (pipeline && block.value) void runStart.start(pipeline)
}

/**
 * An initiative block accepts exactly ONE pipeline — its preset's planning pipeline — and the
 * engine refuses every other, so it gets the same single "Run planning" control the board card and
 * the inspector offer rather than a picker whose every other row would be rejected on click. Same
 * composable as those two surfaces, so which pipeline it starts can't drift across the three.
 */
const isInitiative = computed(() => block.value?.level === 'initiative')
const {
  planningPipeline,
  running: planningRunning,
  starting: planningStarting,
  runPlanning,
} = useInitiativePlanning(() => block.value?.id ?? '')

function close() {
  ui.focus(null)
}

onKeyStroke('Escape', () => {
  if (ui.focusBlockId) close()
})

function openDecisionFor(decisionId: string) {
  if (instance.value) ui.openDecision(instance.value.id, decisionId)
}

function openApprovalFor(approvalId: string) {
  if (instance.value) ui.openApprovalDetail(instance.value.id, approvalId)
}
</script>

<template>
  <!-- The focus-fade Transition is owned by the parent mount (pages/index.vue), so the
       leave animation survives this component being unmounted by its v-if gate. -->
  <div
    v-if="block && statusMeta && typeMeta"
    class="absolute inset-0 z-30 flex flex-col bg-slate-950/95 backdrop-blur"
    role="dialog"
    aria-modal="true"
  >
    <!-- header / breadcrumb -->
    <header class="flex items-center gap-3 border-b border-slate-800 px-6 py-4">
      <UButton
        icon="i-lucide-arrow-left"
        :ui="{ leadingIcon: 'rtl:-scale-x-100', trailingIcon: 'rtl:-scale-x-100' }"
        color="neutral"
        variant="ghost"
        size="sm"
        @click="close"
      >
        {{ t('focus.board') }}
      </UButton>
      <UIcon name="i-lucide-chevron-right" class="h-4 w-4 text-slate-600 rtl:-scale-x-100" />
      <div
        class="flex h-9 w-9 items-center justify-center rounded-lg"
        :style="{ backgroundColor: typeMeta.accent + '22' }"
      >
        <UIcon :name="typeMeta.icon" class="h-5 w-5" :style="{ color: typeMeta.accent }" />
      </div>
      <div>
        <h1 class="text-lg font-semibold text-white">{{ block.title }}</h1>
        <div class="text-xs text-slate-500">
          {{ t('focus.typeSubtitle', { type: typeMeta.label }) }}
        </div>
      </div>
      <UBadge :color="statusMeta.chip as any" variant="subtle" class="ms-2">
        {{ statusMeta.label }}
      </UBadge>
      <div class="ms-auto flex items-center gap-2">
        <!-- An initiative has one legal pipeline, so it gets the button, not the picker. -->
        <UButton
          v-if="isInitiative"
          color="primary"
          variant="soft"
          size="sm"
          icon="i-lucide-play"
          :loading="planningStarting || planningRunning"
          :disabled="!planningPipeline || planningRunning || planningStarting"
          data-testid="focus-run-planning"
          @click="runPlanning"
        >
          {{ t('initiative.inspector.runPlanning') }}
        </UButton>
        <!-- A sandboxed role cannot ask its way out, so the badge REPLACES the toggle rather
             than sitting beside it as a switch that does nothing. -->
        <UBadge
          v-if="!isInitiative && runStart.forced.value"
          color="warning"
          variant="subtle"
          size="sm"
          icon="i-lucide-shield"
          :title="t('focus.dryRunForcedHint')"
          data-testid="focus-dry-run-forced"
        >
          {{ t('focus.dryRun') }}
        </UBadge>
        <USwitch
          v-else-if="!isInitiative && runStart.canRequest.value"
          :model-value="runStart.requested.value"
          size="sm"
          :label="t('focus.dryRun')"
          :title="t('focus.dryRunHint')"
          data-testid="focus-dry-run"
          @update:model-value="runStart.setRequested($event)"
        />
        <!-- The rich picker rather than a list of names: the run starts the moment a row is
             clicked, so the preview is the only chance to see which agents it will run. -->
        <PipelinePicker
          v-else
          model-value=""
          :options="runOptions"
          @update:model-value="runPipeline"
        >
          <template #trigger>
            <UButton
              color="primary"
              variant="soft"
              size="sm"
              icon="i-lucide-play"
              trailing-icon="i-lucide-chevron-down"
            >
              {{ instance ? t('focus.rerunPipeline') : t('focus.runPipeline') }}
            </UButton>
          </template>
        </PipelinePicker>
        <IconButton
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          :label="t('common.close')"
          @click="close"
        />
      </div>
    </header>

    <div class="grid flex-1 grid-cols-[1fr_300px] gap-6 overflow-hidden p-6">
      <!-- main: pipeline flow -->
      <section
        class="flex flex-col overflow-auto rounded-2xl border border-slate-800 bg-slate-900/60 p-6"
      >
        <div class="mb-4 flex items-center gap-2">
          <UIcon name="i-lucide-workflow" class="h-4 w-4 text-slate-500" />
          <h2 class="text-sm font-semibold uppercase tracking-wide text-slate-400">
            {{ instance ? instance.pipelineName : t('focus.noPipelineRunning') }}
          </h2>
        </div>

        <PipelineProgress
          v-if="instance"
          :instance="instance"
          @open-decision="openDecisionFor"
          @open-approval="openApprovalFor"
        />

        <div
          v-else
          class="flex flex-1 items-center justify-center rounded-xl border border-dashed border-slate-700 text-sm text-slate-500"
        >
          {{ t('focus.emptyPipelineHint') }}
        </div>
      </section>

      <!-- side: details -->
      <aside
        class="space-y-4 overflow-auto rounded-2xl border border-slate-800 bg-slate-900/60 p-5"
      >
        <div>
          <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {{ t('focus.description') }}
          </div>
          <p class="text-sm text-slate-300">{{ block.description }}</p>
        </div>
        <div v-if="instance">
          <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {{ t('focus.overallProgress') }}
          </div>
          <UProgress :model-value="Math.round(block.progress * 100)" />
          <div class="mt-1 text-[11px] text-slate-400">
            {{ n(block.progress, 'percent') }}
          </div>
        </div>
        <div>
          <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {{ t('focus.dependencies') }}
          </div>
          <div v-if="deps.length" class="flex flex-wrap gap-1">
            <UBadge v-for="d in deps" :key="d.id" color="neutral" variant="subtle" size="sm">
              {{ d.title }}
            </UBadge>
          </div>
          <div v-else class="text-[11px] text-slate-500">{{ t('focus.noDependencies') }}</div>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.focus-fade-enter-active,
.focus-fade-leave-active {
  transition: opacity 0.18s ease;
}
.focus-fade-enter-from,
.focus-fade-leave-to {
  opacity: 0;
}
</style>
