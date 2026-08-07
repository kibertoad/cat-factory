<script setup lang="ts">
import type { Block, BlockStatus } from '~/types/domain'
import { blockTypeMeta, STATUS_META } from '~/utils/catalog'
import DecisionBadge from './DecisionBadge.vue'
import DraggableTask from './DraggableTask.vue'
import InitiativeCard from './InitiativeCard.vue'
import ModuleFrame from './ModuleFrame.vue'
import ResizeGrips from './ResizeGrips.vue'
import AgentFailureCard from '~/components/board/AgentFailureCard.vue'
import AgentStopButton from '~/components/board/AgentStopButton.vue'
import { useBlockDrag } from '~/composables/useBlockDrag'
import { useFrameStacking } from '~/composables/useFrameStacking'
import { useViewport } from '~/composables/useViewport'

// Vue Flow passes the node's `id` and `data` as props to custom node components.
// Only frames are rendered as board nodes; their tasks live inside the card.
const props = defineProps<{ id: string }>()

const board = useBoardStore()
const execution = useExecutionStore()
const ui = useUiStore()
const tasks = useTasksStore()
const documents = useDocumentsStore()
const agentRuns = useAgentRunsStore()
const services = useServicesStore()
const reviews = useReviewStage()
const access = useWorkspaceAccess()
const uiMode = useUiModeStore()
const { t } = useI18n()
const { lod } = useSemanticZoom()
// Coarse-pointer (touch) bumps the frame-header actions from `xs` to `sm` so
// they clear a comfortable tap target on phones without affecting mouse desktops.
const { isTouch } = useViewport()

const block = computed<Block | undefined>(() => board.getBlock(props.id))
/**
 * This service frame is mounted on more than one board in the org, which is a fact about the
 * SERVICE that only its own card can state: nothing else on the board says the work lands in a
 * repo another board also drives.
 */
const isShared = computed(() => services.isSharedFrame(props.id))
const typeMeta = computed(() => (block.value ? blockTypeMeta(block.value.type) : null))

// ---- this service's children (tasks + modules) -----------------------------
const directTasks = computed(() => board.tasksOf(props.id))
const modules = computed(() => board.modulesOf(props.id))
const initiativeBlocks = computed(() => board.initiativesOf(props.id))
const allTasks = computed(() => board.allTasksUnder(props.id))
const taskIds = computed(() => new Set(allTasks.value.map((t) => t.id)))
const taskCount = computed(() => allTasks.value.length)
const hasTasks = computed(
  () => taskCount.value > 0 || modules.value.length > 0 || initiativeBlocks.value.length > 0,
)
const prTasks = computed(() => allTasks.value.filter((t) => t.status === 'pr_ready').length)
const canvas = computed(() => board.containerSize(props.id))

// Frame status is derived from its tasks — services never reach "done".
const frameStatus = computed<BlockStatus>(() => board.frameStatus(props.id))
const statusMeta = computed(() => STATUS_META[frameStatus.value])
const accent = computed(() => statusMeta.value.color)
// Exhaustive (tier-2) status → label-key map: a new BlockStatus without a label
// fails the typecheck rather than leaking a raw key into the frame badge.
const FRAME_LABEL_KEYS: Record<BlockStatus, string> = {
  planned: 'board.frame.status.planned',
  ready: 'board.frame.status.ready',
  in_progress: 'board.frame.status.in_progress',
  blocked: 'board.frame.status.blocked',
  pr_ready: 'board.frame.status.pr_ready',
  done: 'board.frame.status.done',
}
const statusLabel = computed(() => t(FRAME_LABEL_KEYS[frameStatus.value]))
// The badge is a ROLLUP over the frame's children, not a status anybody set on the service, and
// the label alone never says which child produced it — "Needs attention" names no task, and
// "Live" reads as a health check rather than "caught up". So each status gets its own tooltip
// naming what it is rolled up from. `pr_ready`/`done` are unreachable here (`frameStatus` caps
// below `done`: a service is long-lived and never finishes) but the Record stays exhaustive over
// `BlockStatus` for the same reason the label map does, and mirrors that map's aliasing.
const FRAME_STATUS_HINT_KEYS: Record<BlockStatus, string> = {
  planned: 'board.frame.statusHint.planned',
  ready: 'board.frame.statusHint.ready',
  in_progress: 'board.frame.statusHint.in_progress',
  blocked: 'board.frame.statusHint.blocked',
  pr_ready: 'board.frame.statusHint.pr_ready',
  done: 'board.frame.statusHint.done',
}
const statusHint = computed(() => t(FRAME_STATUS_HINT_KEYS[frameStatus.value]))

const selected = computed(() => ui.selectedBlockId === props.id)

// Every child whose parked run the frame badge speaks for: its tasks AND its initiative
// blocks. An initiative is a frame child like a module and runs an ordinary pipeline (its
// planner parks on a real approval gate), so leaving it out made a whole class of parked run
// invisible at frame level — the badge read "nothing needs you" while a plan sat waiting.
const attentionIds = computed(() => {
  const ids = new Set(taskIds.value)
  for (const i of initiativeBlocks.value) ids.add(i.id)
  return ids
})

// Surface a pending decision from this frame OR any of its children (O(children) map
// lookups, not a scan of every open decision per frame).
const blockDecisions = computed(() => {
  const byBlock = execution.decisionsByBlock
  const out = [...(byBlock.get(props.id) ?? [])]
  for (const id of attentionIds.value) {
    const list = byBlock.get(id)
    if (list) out.push(...list)
  }
  return out
})

function openFirstDecision() {
  const d = blockDecisions.value[0]
  if (d) ui.openDecision(d.instanceId, d.decision.id)
}

// Surface a pending approval gate from this frame OR any of its children — but NOT an
// iterative reviewer gate (requirements-review / clarity-review) that's mid-cycle
// (incorporating / re-reviewing in the driver), which is background work needing no human,
// so it stays off the frame's "Approval" badge.
const blockApprovals = computed(() => {
  const byBlock = execution.approvalsByBlock
  const candidates = [...(byBlock.get(props.id) ?? [])]
  for (const id of attentionIds.value) {
    const list = byBlock.get(id)
    if (list) candidates.push(...list)
  }
  return candidates.filter((a) => !reviews.isBackground(a.agentKind, a.blockId))
})

function openFirstApproval() {
  const a = blockApprovals.value[0]
  if (a) ui.openApprovalDetail(a.instanceId, a.approval.id)
}

// Expanded frames are not Vue Flow-draggable (so the pane can pan through them),
// so they're repositioned by grabbing the header instead. The whole header bar is
// the grab surface — only the action buttons (marked `.nodrag`) opt out, so a press
// on them clicks rather than starts a drag. Frames live in free-floating flow space,
// hence `clamp: false`.
const { startDrag } = useBlockDrag()
function onFrameHandle(e: PointerEvent) {
  if ((e.target as HTMLElement).closest('.nodrag')) return
  if (block.value) startDrag(block.value, e, { clamp: false })
}

// Lift this frame above any overlapping neighbours while the pointer is over it
// (see useFrameStacking + BoardCanvas's frameZIndex).
const { enter: enterFrame, leave: leaveFrame } = useFrameStacking()

function addTask() {
  ui.openAddTask(props.id)
}

// Open the tracker-issue modal scoped to THIS service: the create-in target and the repo-scoped
// issue search are narrowed to this frame and its modules (see `useContainerTargets`).
function createTaskFromIssue() {
  ui.openTaskImport(null, props.id)
}

function addRecurring() {
  ui.openAddRecurring(props.id)
}

/**
 * Start a task from a design link, scoped to THIS service.
 *
 * BASIC tier, unlike the recurring/initiative buttons beside it: for a design-led team this is
 * the everyday delivery loop rather than planning about it, which is the tier bar. It is offered
 * only where a design source is actually connected, so a board that has none carries no control
 * whose first click is a dead end.
 */
function startFromDesign() {
  ui.openStartFromDesign(props.id)
}

// Hunt this service's tracker board for a bug worth picking up. Scoped to THIS frame, so
// an adopted candidate lands here rather than wherever the board's first frame happens to be.
function huntBugs() {
  ui.openBugHunt(null, props.id)
}

function createInitiative() {
  ui.openCreateInitiative(props.id)
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
  <!-- ===================== Redacted: repo access denied ===================== -->
  <!-- This service frame is backed by a repo linked via another member's personal access
       token that the signed-in user can't reach. The server scrubbed its contents; the SPA
       shows only the internal id + a "Permission denied" placeholder (never the repo). -->
  <div
    v-if="block?.accessDenied"
    class="w-56 overflow-hidden rounded-xl border border-slate-700 bg-slate-900/90 shadow-xl backdrop-blur"
    :data-block-id="block.id"
    data-testid="frame-access-denied"
  >
    <div class="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
      <span class="i-lucide-lock h-4 w-4 shrink-0 text-slate-400" />
      <span class="truncate text-sm font-semibold text-slate-200">{{
        t('board.frame.accessDenied.title')
      }}</span>
    </div>
    <div class="px-3 py-3">
      <p class="text-[11px] leading-snug text-slate-400">
        {{ t('board.frame.accessDenied.hint') }}
      </p>
      <code class="mt-2 block truncate font-mono text-[11px] text-slate-500">{{ block.id }}</code>
    </div>
  </div>

  <div
    v-else-if="block"
    class="relative"
    :data-block-id="block.id"
    @pointerenter="enterFrame(block.id)"
    @pointerleave="leaveFrame(block.id)"
  >
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
        :label="t('board.decisionBadge.approvalNeeded')"
        icon="i-lucide-shield-check"
        @open="openFirstApproval"
      />
    </div>

    <!-- ===================== The service card: 2D canvas of tasks + modules =====================
         There is no chip or compact variant: a service is always expanded to its task canvas, at
         every zoom level, so panning is a fixed layout and zooming has no expand/collapse
         transition to snap on. The two gated-off branches that used to sit here (a far-zoom chip
         and a collapsed summary) went with the header's collapse control, since between them they
         held the only render of the "Shared" badge, which now lives in the header below. -->
    <div
      class="relative overflow-visible rounded-2xl border bg-slate-900/95 shadow-2xl backdrop-blur"
      :class="[selected ? 'border-white' : 'border-slate-700', pulseClass]"
    >
      <div class="h-1.5 w-full rounded-t-2xl" :style="{ backgroundColor: accent }" />
      <!-- bootstrap-in-progress banner -->
      <div
        v-if="bootstrapping"
        class="border-b border-amber-900/50 bg-amber-950/30 px-4 py-2"
        data-testid="bootstrap-progress"
      >
        <div class="flex items-center gap-1.5 text-xs">
          <UIcon
            name="i-lucide-loader-circle"
            class="h-4 w-4 shrink-0 animate-spin text-amber-400"
          />
          <span class="text-amber-300">{{ t('board.frame.bootstrappingRepository') }}</span>
          <span v-if="bootstrapSubtasks" class="ms-auto text-amber-200/80">
            {{
              t('board.frame.bootstrapStepsCount', {
                completed: bootstrapSubtasks.completed,
                total: bootstrapSubtasks.total,
              })
            }}
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
      <div class="p-4">
        <!-- frame header: the whole header (the title row AND the stats line below it)
             is the drag handle for the expanded frame. `nopan` stops Vue Flow's pane
             from panning on a start-drag that starts here (it pans via d3-zoom's
             mousedown, which our pointerdown stopPropagation can't intercept), so the
             grab drives the frame move. The action buttons on the right opt out via
             `.nodrag` (onFrameHandle ignores them). `pb-3` provides the gap down to the
             drop zone AND makes that gap part of the grab surface, so no header edge
             falls through to the pane (the parent drops `space-y-3` to avoid doubling
             the gap). -->
        <div
          class="nopan cursor-grab touch-none space-y-3 pb-3 active:cursor-grabbing"
          :title="t('board.frame.dragService')"
          @pointerdown="onFrameHandle"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="flex items-center gap-2">
              <div
                class="flex h-8 w-8 items-center justify-center rounded-lg"
                :style="{ backgroundColor: typeMeta!.accent + '22' }"
              >
                <UIcon
                  :name="typeMeta!.icon"
                  class="h-5 w-5"
                  :style="{ color: typeMeta!.accent }"
                />
              </div>
              <div>
                <div class="flex items-center gap-1.5">
                  <span class="text-sm font-semibold text-white">{{ block.title }}</span>
                  <!-- Mounted on more than one board in the org. On the title row rather than in
                       the action strip, because it qualifies the service's NAME: the work lands in
                       a repo another board also drives. -->
                  <UBadge
                    v-if="isShared"
                    color="info"
                    variant="subtle"
                    size="sm"
                    class="shrink-0"
                    data-testid="frame-shared"
                    :title="t('board.frame.sharedTitle')"
                  >
                    {{ t('board.frame.shared') }}
                  </UBadge>
                </div>
                <div class="text-[11px] text-slate-400">{{ typeMeta!.label }}</div>
              </div>
            </div>
            <div class="flex items-center gap-1">
              <UBadge
                :color="statusMeta.chip as any"
                variant="subtle"
                size="sm"
                :title="statusHint"
                >{{ statusLabel }}</UBadge
              >
              <!-- Board-authoring buttons (create task / from issue / recurring / initiative)
                   are `board.write`, hidden for a read-only viewer, who keeps the status badge
                   (the one view-only affordance here). -->
              <template v-if="access.canWriteBoard.value">
                <UButton
                  class="nodrag"
                  data-testid="frame-add-task"
                  :size="isTouch ? 'sm' : 'xs'"
                  variant="ghost"
                  color="neutral"
                  icon="i-lucide-plus"
                  :title="t('board.frame.addTaskTitle')"
                  @click.stop="addTask"
                />
                <UButton
                  v-if="tasks.anyOffered"
                  class="nodrag"
                  :size="isTouch ? 'sm' : 'xs'"
                  variant="ghost"
                  color="neutral"
                  icon="i-lucide-ticket"
                  :title="t('board.frame.createTaskFromIssueTitle')"
                  @click.stop="createTaskFromIssue"
                />
                <UButton
                  v-if="documents.connectedDesignSources.length > 0"
                  class="nodrag"
                  data-testid="frame-start-from-design"
                  :size="isTouch ? 'sm' : 'xs'"
                  variant="ghost"
                  color="neutral"
                  icon="i-lucide-frame"
                  :title="t('board.frame.startFromDesignTitle')"
                  @click.stop="startFromDesign"
                />
                <!-- Recurring pipelines + initiatives are ADVANCED-tier authoring: both plan
                     work rather than do it (a schedule that fires runs on a cadence, an
                     initiative that groups tasks under a goal), and the basic frame header is
                     the most-used control strip on the board. Hiding the CREATE affordance
                     removes neither's existing state from basic mode — a live schedule still
                     badges its task card and opens its inspector panel, and an initiative is
                     still a block on the board with its own inspector — so what a basic-mode
                     user loses is the ability to author a new one, not sight of one. -->
                <UButton
                  v-if="uiMode.isAdvanced"
                  class="nodrag"
                  data-testid="frame-add-recurring"
                  :size="isTouch ? 'sm' : 'xs'"
                  variant="ghost"
                  color="neutral"
                  icon="i-lucide-repeat"
                  :title="t('board.frame.addRecurringTitle')"
                  @click.stop="addRecurring"
                />
                <UButton
                  v-if="uiMode.isAdvanced"
                  class="nodrag"
                  data-testid="frame-add-initiative"
                  :size="isTouch ? 'sm' : 'xs'"
                  variant="ghost"
                  color="neutral"
                  icon="i-lucide-milestone"
                  :title="t('board.frame.createInitiativeTitle')"
                  @click.stop="createInitiative"
                />
                <UButton
                  v-if="tasks.anyOffered"
                  class="nodrag"
                  data-testid="frame-hunt-bugs"
                  :size="isTouch ? 'sm' : 'xs'"
                  variant="ghost"
                  color="neutral"
                  icon="i-lucide-radar"
                  :title="t('board.frame.huntBugsTitle')"
                  @click.stop="huntBugs"
                />
              </template>
            </div>
          </div>

          <!-- Composition line. It deliberately does NOT carry a done/total tally: the
               per-task status is already on every card in the canvas below, so the
               frame-level "N/M implemented" was a second, coarser answer to a question
               the canvas answers precisely — and the one people misread, since it counts
               every task ever added to the service rather than the work in flight. What
               stays is what the canvas can't show at a glance. -->
          <div
            v-if="modules.length || prTasks"
            class="flex items-center gap-2 text-[10px] uppercase tracking-wide text-slate-500"
          >
            <span v-if="modules.length">{{
              t('board.frame.moduleCount', { count: modules.length }, modules.length)
            }}</span>
            <span v-if="modules.length && prTasks" aria-hidden="true">·</span>
            <span v-if="prTasks" class="text-emerald-400">{{
              t('board.frame.prReadyCount', { count: prTasks })
            }}</span>
          </div>
        </div>

        <!-- the 2D drop zone: modules and loose tasks live here, draggable -->
        <div
          :data-drop-zone="block.id"
          class="nodrag relative rounded-xl bg-slate-950/40"
          :style="{ width: canvas.w + 'px', height: canvas.h + 'px' }"
        >
          <ModuleFrame v-for="m in modules" :key="m.id" :module-id="m.id" />
          <InitiativeCard v-for="i in initiativeBlocks" :key="i.id" :block-id="i.id" />
          <DraggableTask v-for="t in directTasks" :key="t.id" :task-id="t.id" />
          <button
            v-if="!hasTasks && access.canWriteBoard.value"
            type="button"
            data-testid="frame-add-task-empty"
            class="absolute inset-4 flex items-center justify-center gap-1 rounded-lg border border-dashed border-slate-700 text-[11px] text-slate-500 hover:border-slate-500 hover:text-slate-300"
            @click.stop="addTask"
          >
            <UIcon name="i-lucide-plus" class="h-3.5 w-3.5" /> {{ t('board.frame.addFirstTask') }}
          </button>
        </div>
      </div>

      <!-- Every border and corner of the CARD is a resize grip (see ResizeGrips: the geometry,
           the hit bands, and why a north/west drag translates the contents). They used to sit on
           the inner drop zone's edge, 16px of padding inside the visible border and flush against
           the content, where two thin strips read as scrollbars rather than as the frame's border.

           The grips are PHYSICAL (`right-0`, not `end-0`): the resize math derives the box from an
           unmirrored clientX/clientY delta, so a logical (RTL-flipped) grip would render on the
           opposite border from the one the drag actually moves. -->
      <ResizeGrips :block="block" tone="frame" />
    </div>
  </div>
</template>
