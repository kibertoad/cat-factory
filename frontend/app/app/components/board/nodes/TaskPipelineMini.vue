<script setup lang="ts">
import type { AgentState } from '~/types/domain'
import { agentKindMeta } from '~/utils/catalog'
import {
  subtaskIconClass,
  isFailedStep,
  FAILED_STEP_META,
  gateCompanionFor,
  COMPANION_STATE_META,
} from '~/utils/pipelineRender'
import { lodAtLeast } from '~/composables/useSemanticZoom'

// Spatial drill-down inside a task card: at the `steps` zoom band the task's
// build-pipeline steps appear, and one band deeper (`subtasks`) each step's live
// todo breakdown expands — done / in-progress / pending — exactly the way a
// zoomed-in bootstrap card reads. Renders nothing until the task has a run and
// the user has zoomed in far enough, so it's safe to mount on every task card.
const props = defineProps<{ taskId: string }>()

const execution = useExecutionStore()
const ui = useUiStore()
const expansion = useTaskExpansionStore()
const reviews = useReviewStage()
const { t } = useI18n()
const { lod } = useSemanticZoom()

const instance = computed(() => execution.getByBlock(props.taskId))
const steps = computed(() => instance.value?.steps ?? [])

// A failed run is no longer executing: a step left mid-flight (state still
// `working`) must stop spinning, matching the failure card the task card shows.
const runFailed = computed(() => instance.value?.status === 'failed')

// The conditionally-run companion (if any) each step drives — the polling gates'
// helper (ci → ci-fixer, conflicts → conflict-resolver) or the Tester's fixer — with
// its possible/running/completed/skipped state. The board drill-down shows it the same
// way the inspector + focus pipeline do, so a gate working its helper reads as active
// (spinning "Running") rather than a frozen subtask list.
const companionByStep = computed(() => steps.value.map((s) => gateCompanionFor(s, runFailed.value)))

// Expand the pipeline list only when zoomed in far enough AND the board driver
// permits this card — on-screen, and the centre-most of any cards that would
// otherwise overlap (see useTaskExpansion) — so deep-zoom expansions don't pile up.
const showSteps = computed(
  () =>
    lodAtLeast(lod.value, 'steps') && steps.value.length > 0 && expansion.canExpand(props.taskId),
)
const showItems = computed(() => lodAtLeast(lod.value, 'subtasks'))

// Clicking a step opens the full agent step-detail overlay — execution metadata
// (state, timing, model, subtasks) plus the agent's prose output — exactly like
// clicking it from the inspector panel or the focus-view pipeline, rather than
// expanding the text inline inside the board card.
function openStep(i: number) {
  if (instance.value) ui.openStepDetail(instance.value.id, i)
}

/** Per-state accent, matching the inspector/focus pipeline views. */
const STATE_META: Record<AgentState, { color: string; icon: string }> = {
  pending: { color: '#64748b', icon: 'i-lucide-circle-dashed' },
  working: { color: '#6366f1', icon: 'i-lucide-loader' },
  waiting_decision: { color: '#f59e0b', icon: 'i-lucide-circle-help' },
  done: { color: '#22c55e', icon: 'i-lucide-circle-check' },
}

// Same todo-status icons the bootstrap card uses, so a zoomed-in task reads the
// same way as a zoomed-in bootstrap.
const ITEM_ICON: Record<string, string> = {
  completed: 'i-lucide-check-circle-2',
  in_progress: 'i-lucide-loader-circle',
  pending: 'i-lucide-circle',
}
</script>

<template>
  <div v-if="showSteps" class="mt-2 space-y-1 border-t border-slate-800 pt-2">
    <div class="flex items-center gap-1 text-[9px] uppercase tracking-wide text-slate-500">
      <UIcon name="i-lucide-workflow" class="h-2.5 w-2.5" />
      {{ t('board.task.buildSteps') }}
    </div>
    <div v-for="(s, i) in steps" :key="i" class="rounded bg-slate-900/60 px-1.5 py-1">
      <div
        class="flex cursor-pointer items-center gap-1"
        :title="`${agentKindMeta(s.agentKind).label} — ${agentKindMeta(s.agentKind).description}\n${t('board.task.clickToViewStep')}`"
        @click.stop="openStep(i)"
      >
        <UIcon
          :name="agentKindMeta(s.agentKind).icon"
          class="h-3 w-3 shrink-0"
          :style="{ color: agentKindMeta(s.agentKind).color }"
        />
        <span class="truncate text-[10px] text-slate-200">
          {{ agentKindMeta(s.agentKind).label }}
        </span>
        <UIcon
          v-if="s.output"
          name="i-lucide-file-text"
          class="h-2.5 w-2.5 shrink-0 text-slate-500"
        />
        <span
          v-if="s.subtasks && s.subtasks.total > 0"
          class="ms-auto shrink-0 font-mono text-[9px] tabular-nums text-slate-400"
        >
          {{ s.subtasks.completed }}/{{ s.subtasks.total }}
        </span>
        <UIcon
          v-else
          :name="
            isFailedStep(s.state, runFailed) ? FAILED_STEP_META.icon : STATE_META[s.state].icon
          "
          class="ms-auto h-2.5 w-2.5 shrink-0"
          :class="s.state === 'working' && !runFailed ? 'animate-spin' : ''"
          :style="{
            color: isFailedStep(s.state, runFailed)
              ? FAILED_STEP_META.color
              : STATE_META[s.state].color,
          }"
        />
      </div>

      <!-- pending approval gate: jump straight to the conclusions reader. Suppressed
           while a reviewer gate is folding/re-reviewing in the background (no human needed). -->
      <button
        v-if="
          s.approval &&
          s.approval.status === 'pending' &&
          instance &&
          !reviews.isBackground(s.agentKind, props.taskId)
        "
        type="button"
        class="mt-1 flex w-full items-center justify-center gap-1 rounded bg-amber-500 px-1.5 py-0.5 text-[9px] font-semibold text-amber-950 transition hover:bg-amber-400"
        @click.stop="ui.openApprovalDetail(instance.id, s.approval.id)"
      >
        <UIcon name="i-lucide-shield-check" class="h-2.5 w-2.5" />
        {{ t('board.task.reviewAndApprove') }}
      </button>

      <!-- per-step subtask progress bar -->
      <div
        v-if="s.subtasks && s.subtasks.total > 0"
        class="mt-1 h-0.5 w-full overflow-hidden rounded bg-slate-700/60"
      >
        <div
          class="h-full rounded bg-indigo-400 transition-all"
          :style="{ width: `${(s.subtasks.completed / s.subtasks.total) * 100}%` }"
        />
      </div>

      <!-- conditionally-run companion (the gate's ci-fixer / conflict-resolver, or the
           Tester's fixer): a compact running/ran/skipped line, so a gate that's working
           its helper reads as actively fixing rather than a frozen subtask list. -->
      <div v-if="companionByStep[i]" class="mt-1 flex items-center gap-1 text-[9px]">
        <UIcon
          :name="agentKindMeta(companionByStep[i]!.kind).icon"
          class="h-2.5 w-2.5 shrink-0"
          :class="[
            COMPANION_STATE_META[companionByStep[i]!.state].text,
            companionByStep[i]!.state === 'running' ? 'animate-spin' : '',
          ]"
        />
        <span class="truncate text-slate-400">
          {{ agentKindMeta(companionByStep[i]!.kind).label }}
        </span>
        <span
          class="ms-auto shrink-0"
          :class="COMPANION_STATE_META[companionByStep[i]!.state].text"
        >
          {{ COMPANION_STATE_META[companionByStep[i]!.state].label }}
        </span>
      </div>

      <!-- deepest band: the actual todo list (done / in-progress / pending) -->
      <ul v-if="showItems && s.subtasks?.items?.length" class="mt-1 space-y-0.5">
        <li
          v-for="(item, j) in s.subtasks.items"
          :key="j"
          class="flex items-start gap-1 text-[9px]"
          :class="
            item.status === 'completed'
              ? 'text-slate-500 line-through'
              : item.status === 'in_progress'
                ? 'text-slate-100'
                : 'text-slate-400'
          "
        >
          <UIcon
            :name="ITEM_ICON[item.status]"
            class="mt-px h-2.5 w-2.5 shrink-0"
            :class="subtaskIconClass(item.status, runFailed)"
          />
          <span>{{ item.label }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
