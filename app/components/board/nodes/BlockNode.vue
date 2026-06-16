<script setup lang="ts">
import type { Block, BlockStatus } from '~/types/domain'
import { BLOCK_TYPE_META, STATUS_META } from '~/utils/catalog'
import DecisionBadge from './DecisionBadge.vue'
import DraggableTask from './DraggableTask.vue'
import ModuleFrame from './ModuleFrame.vue'
import { useBlockDrag } from '~/composables/useBlockDrag'

// Vue Flow passes the node's `id` and `data` as props to custom node components.
// Only frames are rendered as board nodes; their tasks live inside the card.
const props = defineProps<{ id: string }>()

const board = useBoardStore()
const execution = useExecutionStore()
const ui = useUiStore()
const bootstrap = useBootstrapStore()
const { lod } = useSemanticZoom()

const block = computed<Block | undefined>(() => board.getBlock(props.id))
const typeMeta = computed(() => (block.value ? BLOCK_TYPE_META[block.value.type] : null))

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

function addTask() {
  board.addTask(props.id)
  ui.expandFrame(props.id)
}

// A task needs merging → green pulse; a task needs a decision → amber pulse.
const pulseClass = computed(() => {
  if (frameStatus.value === 'blocked') return 'board-pulse'
  if (prTasks.value > 0) return 'board-pulse-green'
  return ''
})

// ---- repo-bootstrap overlay -------------------------------------------------
// When this service frame was materialised by a (still-running or failed)
// "bootstrap repo" run, surface its live status + subtask progress on the card —
// the user spun up a bootstrap container and watches it adapt + push the repo.
const bootstrapJob = computed(() => bootstrap.byBlock[props.id])
const bootstrapping = computed(() => bootstrapJob.value?.status === 'running')
const bootstrapFailed = computed(() => bootstrapJob.value?.status === 'failed')
const bootstrapSubtasks = computed(() => bootstrapJob.value?.subtasks ?? null)
const bootstrapPct = computed(() => {
  const s = bootstrapSubtasks.value
  if (!s || s.total <= 0) return 0
  return Math.min(100, Math.round((s.completed / s.total) * 100))
})
// Structured failure (classification + hint) when a run faulted; the one-line
// `error` always renders, this adds the "what to do next" hint + extended detail.
const bootstrapFailure = computed(() => bootstrapJob.value?.failure ?? null)

// Retry a failed bootstrap: spins a fresh container server-side and flips the card
// back to "bootstrapping…". Guarded so a double-click can't fire two retries.
const retrying = ref(false)
const toast = useToast()
async function retryBootstrap() {
  const job = bootstrapJob.value
  if (!job || retrying.value) return
  retrying.value = true
  try {
    await bootstrap.retry(job.id)
  } catch (e) {
    toast.add({
      title: 'Retry failed',
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
    })
  } finally {
    retrying.value = false
  }
}
</script>

<template>
  <div v-if="block" class="relative" :data-block-id="block.id">
    <!-- decision indicator floats above the card at all zoom levels -->
    <div v-if="blockDecisions.length" class="absolute -top-3 left-1/2 z-10 -translate-x-1/2">
      <DecisionBadge
        :count="blockDecisions.length"
        :compact="lod === 'far'"
        @open="openFirstDecision"
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
        v-else-if="bootstrapFailed"
        name="i-lucide-alert-triangle"
        class="ml-auto h-3.5 w-3.5 shrink-0 text-rose-400"
        title="Bootstrap failed"
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
      <!-- bootstrap-in-progress / failed banner -->
      <div
        v-if="bootstrapping || bootstrapFailed"
        class="border-b px-3 py-2"
        :class="bootstrapFailed ? 'border-rose-900/60 bg-rose-950/40' : 'border-amber-900/50 bg-amber-950/30'"
      >
        <div class="flex items-center gap-1.5 text-[11px]">
          <UIcon
            v-if="bootstrapping"
            name="i-lucide-loader-circle"
            class="h-3.5 w-3.5 shrink-0 animate-spin text-amber-400"
          />
          <UIcon v-else name="i-lucide-alert-triangle" class="h-3.5 w-3.5 shrink-0 text-rose-400" />
          <span :class="bootstrapFailed ? 'text-rose-300' : 'text-amber-300'">
            {{ bootstrapFailed ? 'Bootstrap failed' : 'Bootstrapping…' }}
          </span>
          <span v-if="bootstrapping && bootstrapSubtasks" class="ml-auto text-amber-200/80">
            {{ bootstrapSubtasks.completed }}/{{ bootstrapSubtasks.total }}
          </span>
        </div>
        <div v-if="bootstrapping" class="mt-1.5 h-1 w-full overflow-hidden rounded bg-amber-900/40">
          <div class="h-full rounded bg-amber-400 transition-all" :style="{ width: bootstrapPct + '%' }" />
        </div>
        <template v-else-if="bootstrapFailed">
          <div class="mt-1 line-clamp-2 text-[10px] text-rose-400/80" :title="bootstrapJob?.error ?? ''">
            {{ bootstrapJob?.error }}
          </div>
          <button
            type="button"
            class="nodrag mt-1.5 flex items-center gap-1 rounded bg-rose-900/40 px-2 py-0.5 text-[10px] text-rose-200 hover:bg-rose-900/70 disabled:opacity-60"
            :disabled="retrying"
            @click.stop="retryBootstrap"
          >
            <UIcon
              :name="retrying ? 'i-lucide-loader-circle' : 'i-lucide-rotate-ccw'"
              class="h-3 w-3"
              :class="{ 'animate-spin': retrying }"
            />
            {{ retrying ? 'Retrying…' : 'Retry' }}
          </button>
        </template>
      </div>
      <div class="space-y-2 p-3">
        <div class="flex items-center gap-2">
          <UIcon
            :name="typeMeta!.icon"
            class="h-4 w-4 shrink-0"
            :style="{ color: typeMeta!.accent }"
          />
          <span class="truncate text-sm font-semibold text-white">{{ block.title }}</span>
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
      <!-- bootstrap-in-progress / failed banner -->
      <div
        v-if="bootstrapping || bootstrapFailed"
        class="border-b px-4 py-2"
        :class="bootstrapFailed ? 'border-rose-900/60 bg-rose-950/40' : 'border-amber-900/50 bg-amber-950/30'"
      >
        <div class="flex items-center gap-1.5 text-xs">
          <UIcon
            v-if="bootstrapping"
            name="i-lucide-loader-circle"
            class="h-4 w-4 shrink-0 animate-spin text-amber-400"
          />
          <UIcon v-else name="i-lucide-alert-triangle" class="h-4 w-4 shrink-0 text-rose-400" />
          <span :class="bootstrapFailed ? 'text-rose-300' : 'text-amber-300'">
            {{ bootstrapFailed ? 'Bootstrap failed' : 'Bootstrapping repository…' }}
          </span>
          <span v-if="bootstrapping && bootstrapSubtasks" class="ml-auto text-amber-200/80">
            {{ bootstrapSubtasks.completed }}/{{ bootstrapSubtasks.total }} steps
          </span>
        </div>
        <div v-if="bootstrapping" class="mt-1.5 h-1 w-full overflow-hidden rounded bg-amber-900/40">
          <div class="h-full rounded bg-amber-400 transition-all" :style="{ width: bootstrapPct + '%' }" />
        </div>
        <template v-else-if="bootstrapFailed">
          <div class="mt-1 text-[11px] text-rose-300/90">{{ bootstrapJob?.error }}</div>
          <p v-if="bootstrapFailure?.hint" class="mt-1 text-[11px] leading-snug text-rose-400/70">
            {{ bootstrapFailure.hint }}
          </p>
          <details
            v-if="bootstrapFailure?.detail && bootstrapFailure.detail !== bootstrapJob?.error"
            class="mt-1"
          >
            <summary class="cursor-pointer text-[10px] text-rose-400/60 hover:text-rose-300">
              Show detail
            </summary>
            <pre class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-rose-950/60 p-1.5 text-[10px] text-rose-200/80">{{ bootstrapFailure.detail }}</pre>
          </details>
          <button
            type="button"
            class="nodrag mt-2 flex items-center gap-1 rounded-md bg-rose-900/40 px-2 py-1 text-[11px] text-rose-200 hover:bg-rose-900/70 disabled:opacity-60"
            :disabled="retrying"
            @click.stop="retryBootstrap"
          >
            <UIcon
              :name="retrying ? 'i-lucide-loader-circle' : 'i-lucide-rotate-ccw'"
              class="h-3.5 w-3.5"
              :class="{ 'animate-spin': retrying }"
            />
            {{ retrying ? 'Retrying…' : 'Retry bootstrap' }}
          </button>
        </template>
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
        </div>
      </div>
    </div>
  </div>
</template>
