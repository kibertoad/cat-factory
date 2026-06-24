<script setup lang="ts">
import type { Block, BlockStatus } from '~/types/domain'
import { blockTypeMeta, STATUS_META } from '~/utils/catalog'
import DecisionBadge from './DecisionBadge.vue'
import DraggableTask from './DraggableTask.vue'
import ModuleFrame from './ModuleFrame.vue'
import AgentFailureCard from '~/components/board/AgentFailureCard.vue'
import AgentStopButton from '~/components/board/AgentStopButton.vue'
import { useBlockDrag } from '~/composables/useBlockDrag'
import { useFrameResize } from '~/composables/useFrameResize'

// Vue Flow passes the node's `id` and `data` as props to custom node components.
// Only frames are rendered as board nodes; their tasks live inside the card.
const props = defineProps<{ id: string }>()

const board = useBoardStore()
const execution = useExecutionStore()
const ui = useUiStore()
const agentRuns = useAgentRunsStore()
const services = useServicesStore()
const reviews = useReviewStage()
const { lod } = useSemanticZoom()

const block = computed<Block | undefined>(() => board.getBlock(props.id))
/** This service frame is mounted on more than one board in the org. */
const isShared = computed(() => services.isSharedFrame(props.id))
const typeMeta = computed(() => (block.value ? blockTypeMeta(block.value.type) : null))

// ---- this service's children (tasks + modules) -----------------------------
const directTasks = computed(() => board.tasksOf(props.id))
const modules = computed(() => board.modulesOf(props.id))
const allTasks = computed(() => board.allTasksUnder(props.id))
const taskIds = computed(() => new Set(allTasks.value.map((t) => t.id)))
const taskCount = computed(() => allTasks.value.length)
const hasTasks = computed(() => taskCount.value > 0 || modules.value.length > 0)
const mergedTasks = computed(() => allTasks.value.filter((t) => t.status === 'done').length)
const prTasks = computed(() => allTasks.value.filter((t) => t.status === 'pr_ready').length)
const canvas = computed(() => board.containerSize(props.id))

// Frame status is derived from its tasks — services never reach "done".
const frameStatus = computed<BlockStatus>(() => board.frameStatus(props.id))
const statusMeta = computed(() => STATUS_META[frameStatus.value])
const accent = computed(() => statusMeta.value.color)
const FRAME_LABEL: Record<BlockStatus, string> = {
  planned: 'No tasks',
  ready: 'Live',
  in_progress: 'Active',
  blocked: 'Needs attention',
  pr_ready: 'Active',
  done: 'Live',
}
const statusLabel = computed(() => FRAME_LABEL[frameStatus.value])

const selected = computed(() => ui.selectedBlockId === props.id)
const expanded = computed(() => ui.isFrameExpanded(props.id))
// At far zoom we only ever show the chip; otherwise an expanded frame shows tasks.
const showExpanded = computed(() => expanded.value && lod.value !== 'far')

// Surface a pending decision from this frame OR any of its tasks.
const blockDecisions = computed(() =>
  execution.openDecisions.filter((d) => d.blockId === props.id || taskIds.value.has(d.blockId)),
)

function openFirstDecision() {
  const d = blockDecisions.value[0]
  if (d) ui.openDecision(d.instanceId, d.decision.id)
}

// Surface a pending approval gate from this frame OR any of its tasks — but NOT an
// iterative reviewer gate (requirements-review / clarity-review) that's mid-cycle
// (incorporating / re-reviewing in the driver), which is background work needing no human,
// so it stays off the frame's "Approval" badge.
const blockApprovals = computed(() =>
  execution.openApprovals.filter(
    (a) =>
      (a.blockId === props.id || taskIds.value.has(a.blockId)) &&
      !reviews.isBackground(a.agentKind, a.blockId),
  ),
)

function openFirstApproval() {
  const a = blockApprovals.value[0]
  if (a) ui.openApprovalDetail(a.instanceId, a.approval.id)
}

function toggleExpand() {
  ui.toggleFrame(props.id)
}

// Expanded frames are not Vue Flow-draggable (so the pane can pan through them),
// so they're repositioned by grabbing the header handle instead. Frames live in
// free-floating flow space, hence `clamp: false`.
const { startDrag } = useBlockDrag()
function onFrameHandle(e: PointerEvent) {
  if (block.value) startDrag(block.value, e, { clamp: false })
}

// Miro-style frame resizing: drag the right / bottom edges or the corner. Handles
// live on the expanded card's drop zone (see template); the composable clamps to
// the frame's content extent and persists the size on release.
const { startResize } = useFrameResize()
function onResize(e: PointerEvent, edge: 'e' | 's' | 'se') {
  if (block.value) startResize(block.value, e, edge)
}

function addTask() {
  ui.expandFrame(props.id)
  ui.openAddTask(props.id)
}

function addRecurring() {
  ui.openAddRecurring(props.id)
}

// A task needs merging → green pulse; a task needs a decision → amber pulse.
const pulseClass = computed(() => {
  if (frameStatus.value === 'blocked') return 'board-pulse'
  if (prTasks.value > 0) return 'board-pulse-green'
  return ''
})

// ---- agent-run overlay ------------------------------------------------------
// When this service frame was materialised by a "bootstrap repo" run, surface its
// live status + subtask progress on the card (the user watches the container adapt
// + push the repo), and the shared failure banner + retry if it faulted. Derived
// from the unified agentRuns store, keyed by this frame's block id.
const run = computed(() => agentRuns.byBlock[props.id])
const bootstrapping = computed(
  () => run.value?.kind === 'bootstrap' && run.value.status === 'running',
)
const runFailed = computed(() => run.value?.status === 'failed')
const bootstrapSubtasks = computed(() =>
  bootstrapping.value ? (run.value?.subtasks ?? null) : null,
)
const bootstrapPct = computed(() => {
  const s = bootstrapSubtasks.value
  if (!s || s.total <= 0) return 0
  return Math.min(100, Math.round((s.completed / s.total) * 100))
})
// The actual todo items the agent is working through, surfaced on the expanded
// card so a zoomed-in user sees the task list, not just the "N/M" count.
const bootstrapItems = computed(() => bootstrapSubtasks.value?.items ?? [])
const ITEM_ICON: Record<string, string> = {
  completed: 'i-lucide-check-circle-2',
  in_progress: 'i-lucide-loader-circle',
  pending: 'i-lucide-circle',
}
</script>

<template>
  <div v-if="block" class="relative" :data-block-id="block.id">
    <!-- decision / approval indicator floats above the card at all zoom levels -->
    <div
      v-if="blockDecisions.length || blockApprovals.length"
      class="absolute -top-3 left-1/2 z-10 flex -translate-x-1/2 gap-1"
    >
      <DecisionBadge
        v-if="blockDecisions.length"
        :count="blockDecisions.length"
        :compact="lod === 'far'"
        @open="openFirstDecision"
      />
      <DecisionBadge
        v-if="blockApprovals.length"
        :count="blockApprovals.length"
        :compact="lod === 'far'"
        label="Approval needed"
        icon="i-lucide-shield-check"
        @open="openFirstApproval"
      />
    </div>

    <!-- ===================== FAR: glanceable chip ===================== -->
    <div
      v-if="lod === 'far'"
      class="flex w-44 items-center gap-2 rounded-xl border-2 px-3 py-3 shadow-lg backdrop-blur"
      :class="[selected ? 'border-white' : '', pulseClass]"
      :style="{ borderColor: accent, backgroundColor: accent + '26' }"
    >
      <span class="h-3 w-3 shrink-0 rounded-full" :style="{ backgroundColor: accent }" />
      <span class="truncate text-sm font-semibold text-white">{{ block.title }}</span>
      <UIcon
        v-if="bootstrapping"
        name="i-lucide-loader-circle"
        class="ml-auto h-3.5 w-3.5 shrink-0 animate-spin text-amber-400"
        title="Bootstrapping…"
      />
      <UIcon
        v-else-if="runFailed"
        name="i-lucide-alert-triangle"
        class="ml-auto h-3.5 w-3.5 shrink-0 text-rose-400"
        title="Run failed"
      />
      <span v-else-if="hasTasks" class="ml-auto shrink-0 text-[11px] text-slate-300">
        {{ mergedTasks }}/{{ taskCount }}
      </span>
    </div>

    <!-- ===================== COMPACT: summary (collapsed) ===================== -->
    <div
      v-else-if="!showExpanded"
      class="w-56 overflow-hidden rounded-xl border bg-slate-900/90 shadow-xl backdrop-blur"
      :class="[selected ? 'border-white' : 'border-slate-700', pulseClass]"
    >
      <div class="h-1.5 w-full" :style="{ backgroundColor: accent }" />
      <!-- bootstrap-in-progress banner -->
      <div v-if="bootstrapping" class="border-b border-amber-900/50 bg-amber-950/30 px-3 py-2">
        <div class="flex items-center gap-1.5 text-[11px]">
          <UIcon
            name="i-lucide-loader-circle"
            class="h-3.5 w-3.5 shrink-0 animate-spin text-amber-400"
          />
          <span class="text-amber-300">Bootstrapping…</span>
          <span v-if="bootstrapSubtasks" class="ml-auto text-amber-200/80">
            {{ bootstrapSubtasks.completed }}/{{ bootstrapSubtasks.total }}
          </span>
        </div>
        <div class="mt-1.5 h-1 w-full overflow-hidden rounded bg-amber-900/40">
          <div
            class="h-full rounded bg-amber-400 transition-all"
            :style="{ width: bootstrapPct + '%' }"
          />
        </div>
        <div v-if="run" class="mt-2 flex justify-end">
          <AgentStopButton :run-id="run.runId" :kind="run.kind" size="xs" variant="ghost" />
        </div>
      </div>
      <!-- failed run: shared failure banner + retry -->
      <div v-else-if="runFailed && run" class="p-2">
        <AgentFailureCard :run="run" variant="compact" />
      </div>
      <div class="space-y-2 p-3">
        <div class="flex items-center gap-2">
          <UIcon
            :name="typeMeta!.icon"
            class="h-4 w-4 shrink-0"
            :style="{ color: typeMeta!.accent }"
          />
          <span class="truncate text-sm font-semibold text-white">{{ block.title }}</span>
          <UBadge
            v-if="isShared"
            color="info"
            variant="subtle"
            size="sm"
            class="shrink-0"
            title="Shared across workspaces in this org"
          >
            Shared
          </UBadge>
        </div>
        <div class="flex items-center justify-between">
          <UBadge :color="statusMeta.chip as any" variant="subtle" size="sm">{{
            statusLabel
          }}</UBadge>
          <span class="text-[11px] text-slate-400"
            >{{ taskCount }} task{{ taskCount === 1 ? '' : 's' }}</span
          >
        </div>
        <button
          type="button"
          class="nodrag flex w-full items-center gap-1 rounded-md bg-slate-800/60 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-800"
          @click.stop="toggleExpand"
        >
          <UIcon name="i-lucide-layers" class="h-3 w-3 text-slate-400" />
          <span v-if="hasTasks">{{ mergedTasks }}/{{ taskCount }} merged</span>
          <span v-else>No tasks yet</span>
          <span v-if="prTasks" class="text-emerald-400">· {{ prTasks }} PR</span>
          <UIcon name="i-lucide-chevron-down" class="ml-auto h-3 w-3" />
        </button>
      </div>
    </div>

    <!-- ===================== EXPANDED: 2D canvas of tasks + modules ===================== -->
    <div
      v-else
      class="overflow-visible rounded-2xl border bg-slate-900/95 shadow-2xl backdrop-blur"
      :class="[selected ? 'border-white' : 'border-slate-700', pulseClass]"
    >
      <div class="h-1.5 w-full rounded-t-2xl" :style="{ backgroundColor: accent }" />
      <!-- bootstrap-in-progress banner -->
      <div v-if="bootstrapping" class="border-b border-amber-900/50 bg-amber-950/30 px-4 py-2">
        <div class="flex items-center gap-1.5 text-xs">
          <UIcon
            name="i-lucide-loader-circle"
            class="h-4 w-4 shrink-0 animate-spin text-amber-400"
          />
          <span class="text-amber-300">Bootstrapping repository…</span>
          <span v-if="bootstrapSubtasks" class="ml-auto text-amber-200/80">
            {{ bootstrapSubtasks.completed }}/{{ bootstrapSubtasks.total }} steps
          </span>
        </div>
        <div class="mt-1.5 h-1 w-full overflow-hidden rounded bg-amber-900/40">
          <div
            class="h-full rounded bg-amber-400 transition-all"
            :style="{ width: bootstrapPct + '%' }"
          />
        </div>
        <!-- the actual todo list, once the agent has reported any items -->
        <ul v-if="bootstrapItems.length" class="mt-2 space-y-1">
          <li
            v-for="(item, i) in bootstrapItems"
            :key="i"
            class="flex items-start gap-1.5 text-[11px]"
            :class="
              item.status === 'completed'
                ? 'text-amber-200/60 line-through'
                : item.status === 'in_progress'
                  ? 'text-amber-100'
                  : 'text-amber-200/80'
            "
          >
            <UIcon
              :name="ITEM_ICON[item.status]"
              class="mt-px h-3 w-3 shrink-0"
              :class="[
                item.status === 'in_progress' ? 'animate-spin text-amber-400' : '',
                item.status === 'completed' ? 'text-emerald-400' : 'text-amber-400/70',
              ]"
            />
            <span>{{ item.label }}</span>
          </li>
        </ul>
        <div v-if="run" class="mt-2 flex justify-end">
          <AgentStopButton :run-id="run.runId" :kind="run.kind" size="xs" variant="ghost" />
        </div>
      </div>
      <!-- failed run: shared failure banner + retry -->
      <div v-else-if="runFailed && run" class="p-3">
        <AgentFailureCard :run="run" variant="expanded" />
      </div>
      <div class="space-y-3 p-4">
        <!-- frame header (doubles as the drag handle for the expanded frame) -->
        <div class="flex items-start justify-between gap-2">
          <div
            class="flex cursor-grab items-center gap-2 active:cursor-grabbing"
            title="Drag service"
            @pointerdown="onFrameHandle"
          >
            <div
              class="flex h-8 w-8 items-center justify-center rounded-lg"
              :style="{ backgroundColor: typeMeta!.accent + '22' }"
            >
              <UIcon :name="typeMeta!.icon" class="h-5 w-5" :style="{ color: typeMeta!.accent }" />
            </div>
            <div>
              <div class="text-sm font-semibold text-white">{{ block.title }}</div>
              <div class="text-[11px] text-slate-400">{{ typeMeta!.label }}</div>
            </div>
          </div>
          <div class="flex items-center gap-1">
            <UBadge :color="statusMeta.chip as any" variant="subtle" size="sm">{{
              statusLabel
            }}</UBadge>
            <UButton
              class="nodrag"
              size="xs"
              variant="ghost"
              color="neutral"
              icon="i-lucide-plus"
              title="Add task"
              @click.stop="addTask"
            />
            <UButton
              class="nodrag"
              size="xs"
              variant="ghost"
              color="neutral"
              icon="i-lucide-repeat"
              title="Add recurring pipeline"
              @click.stop="addRecurring"
            />
            <UButton
              class="nodrag"
              size="xs"
              variant="ghost"
              color="neutral"
              icon="i-lucide-chevron-up"
              title="Collapse"
              @click.stop="toggleExpand"
            />
          </div>
        </div>

        <div class="flex items-center gap-2 text-[10px] uppercase tracking-wide text-slate-500">
          <span>{{ mergedTasks }}/{{ taskCount }} implemented</span>
          <span v-if="modules.length"
            >· {{ modules.length }} module{{ modules.length === 1 ? '' : 's' }}</span
          >
          <span v-if="prTasks" class="text-emerald-400">· {{ prTasks }} PR ready</span>
        </div>

        <!-- the 2D drop zone: modules and loose tasks live here, draggable -->
        <div
          :data-drop-zone="block.id"
          class="nodrag relative rounded-xl bg-slate-950/40"
          :style="{ width: canvas.w + 'px', height: canvas.h + 'px' }"
        >
          <ModuleFrame v-for="m in modules" :key="m.id" :module-id="m.id" />
          <DraggableTask v-for="t in directTasks" :key="t.id" :task-id="t.id" />
          <button
            v-if="!hasTasks"
            type="button"
            class="absolute inset-4 flex items-center justify-center gap-1 rounded-lg border border-dashed border-slate-700 text-[11px] text-slate-500 hover:border-slate-500 hover:text-slate-300"
            @click.stop="addTask"
          >
            <UIcon name="i-lucide-plus" class="h-3.5 w-3.5" /> Add the first task
          </button>

          <!-- resize handles (drag the borders to resize the service, Miro-style) -->
          <div
            class="nodrag absolute right-0 top-0 h-full w-2 cursor-ew-resize hover:bg-sky-400/20"
            title="Drag to resize"
            @pointerdown="onResize($event, 'e')"
          />
          <div
            class="nodrag absolute bottom-0 left-0 h-2 w-full cursor-ns-resize hover:bg-sky-400/20"
            title="Drag to resize"
            @pointerdown="onResize($event, 's')"
          />
          <div
            class="nodrag absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
            title="Drag to resize"
            @pointerdown="onResize($event, 'se')"
          >
            <span
              class="absolute bottom-1 right-1 h-2 w-2 rounded-sm border-b-2 border-r-2 border-slate-500"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
