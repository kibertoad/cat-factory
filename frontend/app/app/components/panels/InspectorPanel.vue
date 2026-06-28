<script setup lang="ts">
import type { Block, BlockStatus } from '~/types/domain'
import { blockTypeMeta, STATUS_META } from '~/utils/catalog'
import TaskContextDocs from '~/components/documents/TaskContextDocs.vue'
import TaskContextIssues from '~/components/tasks/TaskContextIssues.vue'
import TaskAgentConfig from '~/components/panels/inspector/TaskAgentConfig.vue'
import ServiceTestConfig from '~/components/panels/inspector/ServiceTestConfig.vue'
import ServiceFragments from '~/components/panels/inspector/ServiceFragments.vue'
import ServiceReleaseHealthConfig from '~/components/panels/inspector/ServiceReleaseHealthConfig.vue'
import ContainerSummary from '~/components/panels/inspector/ContainerSummary.vue'
import TaskDependencies from '~/components/panels/inspector/TaskDependencies.vue'
import TaskStructure from '~/components/panels/inspector/TaskStructure.vue'
import TaskRunSettings from '~/components/panels/inspector/TaskRunSettings.vue'
import TaskExecution from '~/components/panels/inspector/TaskExecution.vue'
import EpicChildren from '~/components/panels/inspector/EpicChildren.vue'
import RecurringScheduleSettings from '~/components/panels/inspector/RecurringScheduleSettings.vue'
import AgentFailureCard from '~/components/board/AgentFailureCard.vue'
import AgentStopButton from '~/components/board/AgentStopButton.vue'

const board = useBoardStore()
const pipelines = usePipelinesStore()
const execution = useExecutionStore()
const ui = useUiStore()
const documents = useDocumentsStore()
const tasks = useTasksStore()
const fragments = useFragmentsStore()
const agentRuns = useAgentRunsStore()
const github = useGitHubStore()
const recurring = useRecurringPipelinesStore()
const requirements = useRequirementsStore()

// When the selected task block backs a recurring pipeline, the inspector shows the
// schedule controls + history, and "Delete" removes the schedule (block + history).
const schedule = computed(() => (block.value ? recurring.byBlock(block.value.id) : undefined))

onMounted(() => {
  fragments.ensureLoaded()
  github.ensureLoaded()
})

/** Open the document import/spawn flow, targeting this container's frame. */
function spawnFromDocument() {
  if (!block.value) return
  const frameId = isFrame.value ? block.value.id : (board.serviceOf(block.value)?.id ?? null)
  ui.openDocumentImport(frameId)
}

const block = computed<Block | undefined>(() =>
  ui.selectedBlockId ? board.getBlock(ui.selectedBlockId) : undefined,
)
const level = computed(() => block.value?.level ?? 'frame')
const isFrame = computed(() => level.value === 'frame')
const isContainer = computed(() => level.value === 'frame' || level.value === 'module')
const isTask = computed(() => level.value === 'task')
const isEpic = computed(() => level.value === 'epic')

const instance = computed(() => execution.getInstance(block.value?.executionId))
const typeMeta = computed(() => (block.value ? blockTypeMeta(block.value.type) : null))

// Containers show a derived activity status (never "done"); tasks use their own.
const FRAME_LABEL: Record<BlockStatus, string> = {
  planned: 'No tasks',
  ready: 'Live',
  in_progress: 'Active',
  blocked: 'Needs attention',
  pr_ready: 'Active',
  done: 'Live',
}
const effectiveStatus = computed<BlockStatus>(() =>
  isContainer.value ? board.frameStatus(block.value!.id) : block.value!.status,
)
const statusMeta = computed(() => (block.value ? STATUS_META[effectiveStatus.value] : null))
const statusLabel = computed(() =>
  isContainer.value ? FRAME_LABEL[effectiveStatus.value] : statusMeta.value!.label,
)

const runnable = computed(() => (block.value ? board.isRunnable(block.value.id) : false))

// The delete control names what it removes, so selecting a task and deleting it
// reads as "Delete task" rather than ambiguously removing the whole service.
const deleteLabel = computed(() =>
  schedule.value
    ? 'Delete recurring pipeline'
    : isTask.value
      ? 'Delete task'
      : level.value === 'module'
        ? 'Delete module'
        : 'Delete service',
)

// A task is "started" once a pipeline has been launched on it (it has an
// execution, or has moved past the pre-run states). Until then the user can keep
// editing its title + description; afterwards those details are locked. Non-task
// containers (frames / modules) are always editable.
const started = computed(
  () =>
    isTask.value &&
    (!!block.value?.executionId || !['planned', 'ready'].includes(block.value!.status)),
)
const editable = computed(() => !started.value)

function saveTitle() {
  const b = block.value
  if (!b) return
  const next = b.title.trim()
  if (next) board.updateBlock(b.id, { title: next })
}
function saveDescription() {
  const b = block.value
  if (!b) return
  board.updateBlock(b.id, { description: b.description ?? '' })
}

// The GitHub repo backing this service (a frame), if one is linked. Linkage lives
// on the github_repos projection (its `blockId`), not on the block itself.
const serviceRepo = computed(() =>
  isFrame.value && block.value ? github.repoForBlock(block.value.id) : undefined,
)
const serviceRepoUrl = computed(() =>
  serviceRepo.value ? github.repoUrl(serviceRepo.value.githubId) : null,
)

// A task's work branch on GitHub, once the agent has pushed one (a PR branch is
// recorded on the block). Repo linkage lives on the owning service frame, not the
// task, so resolve the repo by walking up to the frame; fall back to deriving the
// repo base from the PR url when the projection hasn't loaded. Null until a branch
// exists, so the link only appears after one is created.
const taskBranchUrl = computed(() => {
  const pr = isTask.value ? block.value?.pullRequest : undefined
  if (!pr?.branch || !block.value) return null
  const frame = board.serviceOf(block.value)
  const repo = frame ? github.repoForBlock(frame.id) : undefined
  const base = repo ? github.repoUrl(repo.githubId) : pr.url.replace(/\/pull\/\d+$/, '')
  return base ? `${base}/tree/${pr.branch}` : null
})

const runMenu = computed(() =>
  pipelines.pipelines.map((p) => ({
    label: p.name,
    icon: 'i-lucide-play',
    onSelect: () => block.value && execution.start(block.value.id, p),
  })),
)

function remove() {
  if (!block.value) return
  const id = block.value.id
  // Close the inspector right away; the stores hide the block optimistically and
  // restore it (with a toast) only if the backend delete fails.
  ui.select(null)
  // A schedule owns its reused block + run history — removing the schedule deletes
  // them server-side, so delete the schedule rather than orphaning it.
  if (schedule.value) {
    void recurring.remove(schedule.value.id)
    return
  }
  execution.cancel(id)
  void board.removeBlock(id)
}

// ---- failed agent run (bootstrap or execution) ------------------------------
// A block whose current run failed surfaces the shared failure banner + retry,
// keyed by block id — covering a failed "bootstrap repo" frame and (for tasks) a
// failed pipeline execution alike.
const failedRun = computed(() => {
  const run = block.value ? agentRuns.byBlock[block.value.id] : undefined
  return run && run.status === 'failed' ? run : null
})

// A running run on a container frame (a "bootstrapping…" service). Tasks surface
// their own Stop in TaskExecution, so this covers the bootstrap case the board was
// previously unable to stop. Drives the inspector's Stop control.
const runningRun = computed(() => {
  if (!isContainer.value) return null
  const run = block.value ? agentRuns.byBlock[block.value.id] : undefined
  return run && run.status === 'running' ? run : null
})

// ---- requirements review (collected requirements → react → rework) ----------
// The reviewer runs automatically as the first pipeline gate step (no manual entry
// point), but the inspector still probes + caches the block's review so the
// description can freeze in favour of the reworked requirements document once it
// exists (and so a prior incorporated doc can surface as a base after a reset).
watch(
  () => (isTask.value ? block.value?.id : undefined),
  (id) => {
    if (id) void requirements.load(id)
  },
  { immediate: true },
)
const reqReview = computed(() => (block.value ? requirements.reviewFor(block.value.id) : null))
const reqReworked = computed(() => reqReview.value?.status === 'incorporated')
const reqReworkedText = computed(() => reqReview.value?.incorporatedRequirements ?? '')
// Once a task's requirements have been reworked, the standardized document is what
// every agent step consumes — so the raw description is frozen (read-only) and hidden
// behind an expander, with the reworked requirements taking focus instead.
const frozenByRework = computed(() => isTask.value && reqReworked.value)
// After a "stop & reset" the task is editable again (phase zero) but the LAST incorporated
// requirements survive on the review as a base to rework from — surfaced read-only here.
const reqHasPriorDoc = computed(() => isTask.value && !reqReworked.value && !!reqReworkedText.value)
const showOriginalDescription = ref(false)
</script>

<template>
  <div
    v-if="block && statusMeta && typeMeta"
    data-testid="inspector-panel"
    class="fixed inset-x-0 bottom-0 z-30 overflow-hidden rounded-t-2xl border border-slate-700 bg-slate-900/95 shadow-2xl backdrop-blur lg:absolute lg:inset-x-auto lg:bottom-auto lg:right-4 lg:top-4 lg:z-20 lg:w-80 lg:rounded-2xl"
  >
    <div class="h-1.5 w-full" :style="{ backgroundColor: statusMeta.color }" />
    <!-- A tall task (execution steps + scenarios + docs) can overflow the
         viewport; cap the body height and let it scroll so the lower controls
         (Run / Focus / Delete) stay reachable. The status bar above stays put.
         On compact viewports the panel is a bottom sheet capped to the visible
         height (dvh excludes mobile browser chrome). -->
    <div class="max-h-[80dvh] space-y-4 overflow-y-auto p-4 lg:max-h-[calc(100vh-5rem)]">
      <!-- header -->
      <div class="flex items-start justify-between gap-2">
        <div class="flex items-center gap-2">
          <div
            class="flex h-9 w-9 items-center justify-center rounded-lg"
            :style="{ backgroundColor: typeMeta.accent + '22' }"
          >
            <UIcon :name="typeMeta.icon" class="h-5 w-5" :style="{ color: typeMeta.accent }" />
          </div>
          <div>
            <div class="text-sm font-semibold text-white">{{ block.title }}</div>
            <div class="mt-0.5 flex items-center gap-1.5">
              <UBadge :color="statusMeta.chip as any" variant="subtle" size="sm">
                {{ statusLabel }}
              </UBadge>
              <span class="text-[10px] uppercase tracking-wide text-slate-500">{{ level }}</span>
            </div>
          </div>
        </div>
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          size="xs"
          @click="ui.select(null)"
        />
      </div>

      <!-- editable identity: title + description. Edits persist to the backend.
           A task's details lock once it has been started (a pipeline launched), and
           once its requirements have been reworked the description is frozen in favour
           of the standardized requirements document. -->
      <div class="space-y-2">
        <UInput
          v-if="editable && !frozenByRework"
          v-model="block.title"
          size="sm"
          class="w-full"
          placeholder="Title…"
          @change="saveTitle"
          @blur="saveTitle"
        />

        <!-- reworked: the standardized requirements document takes focus; the raw
             description is frozen and tucked behind an expander. -->
        <template v-if="frozenByRework">
          <div class="rounded-lg border border-emerald-900/60 bg-emerald-950/20 p-3">
            <div
              class="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-400"
            >
              <UIcon name="i-lucide-file-check-2" class="h-3.5 w-3.5" />
              Reworked requirements
            </div>
            <p class="line-clamp-5 whitespace-pre-line text-[13px] leading-relaxed text-slate-300">
              {{ reqReworkedText }}
            </p>
            <div class="mt-2 flex items-center justify-between gap-2">
              <p class="text-[11px] text-slate-500">Agent steps use this document.</p>
              <UButton
                color="neutral"
                variant="link"
                size="xs"
                icon="i-lucide-maximize-2"
                @click="ui.openRequirementReview(block.id)"
              >
                Open
              </UButton>
            </div>
          </div>
          <UButton
            color="neutral"
            variant="ghost"
            size="xs"
            :icon="showOriginalDescription ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
            @click="showOriginalDescription = !showOriginalDescription"
          >
            Original description (frozen)
          </UButton>
          <UTextarea
            v-if="showOriginalDescription"
            :model-value="block.description"
            :rows="2"
            autoresize
            size="sm"
            class="w-full"
            disabled
            placeholder="No description"
          />
        </template>

        <!-- normal: editable (or started-locked) description -->
        <template v-else>
          <UTextarea
            v-model="block.description"
            :rows="2"
            autoresize
            size="sm"
            class="w-full"
            :disabled="!editable"
            placeholder="Describe this block…"
            @change="saveDescription"
            @blur="saveDescription"
          />
          <p v-if="isTask && !editable" class="flex items-center gap-1 text-[11px] text-slate-500">
            <UIcon name="i-lucide-lock" class="h-3 w-3" />
            This task has started — its details are locked.
          </p>

          <!-- prior incorporated requirements kept as a base after a review-driven reset -->
          <div v-if="reqHasPriorDoc" class="rounded-lg border border-slate-700 bg-slate-800/40 p-3">
            <div
              class="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400"
            >
              <UIcon name="i-lucide-history" class="h-3.5 w-3.5" />
              Last incorporated requirements
            </div>
            <p class="line-clamp-5 whitespace-pre-line text-[13px] leading-relaxed text-slate-300">
              {{ reqReworkedText }}
            </p>
            <p class="mt-2 text-[11px] text-slate-500">
              From the previous review. Use it as a base — edit the description above and resubmit.
            </p>
          </div>
        </template>
      </div>

      <!-- failed run (bootstrap or execution): shared failure banner + retry -->
      <AgentFailureCard v-if="failedRun" :run="failedRun" />

      <!-- running bootstrap: let the user stop it (kills the container) -->
      <div
        v-else-if="runningRun"
        class="flex items-center justify-between gap-2 rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2"
      >
        <span class="flex items-center gap-1.5 text-xs text-amber-300">
          <UIcon name="i-lucide-loader-circle" class="h-3.5 w-3.5 animate-spin" />
          Bootstrapping…
        </span>
        <AgentStopButton :run-id="runningRun.runId" :kind="runningRun.kind" size="xs" />
      </div>

      <!-- external links -->
      <div class="flex flex-wrap gap-2">
        <UButton
          v-if="serviceRepoUrl"
          :to="serviceRepoUrl"
          target="_blank"
          rel="noopener"
          color="neutral"
          variant="soft"
          size="xs"
          icon="i-lucide-github"
          trailing-icon="i-lucide-external-link"
        >
          {{ serviceRepo!.owner }}/{{ serviceRepo!.name }}
        </UButton>
        <UButton
          v-if="taskBranchUrl"
          :to="taskBranchUrl"
          target="_blank"
          rel="noopener"
          color="neutral"
          variant="soft"
          size="xs"
          icon="i-lucide-git-branch"
          trailing-icon="i-lucide-external-link"
        >
          {{ block!.pullRequest!.branch }}
        </UButton>
        <UButton
          v-if="tasks.available"
          color="neutral"
          variant="soft"
          size="xs"
          icon="i-lucide-ticket"
          @click="ui.openTaskImport()"
        >
          {{ tasks.anyOffered ? 'Import issue' : 'Connect a tracker' }}
        </UButton>
        <UButton
          v-if="isContainer && documents.available && documents.anyConnected"
          color="neutral"
          variant="soft"
          size="xs"
          icon="i-lucide-wand-sparkles"
          @click="spawnFromDocument"
        >
          Spawn from document
        </UButton>
      </div>

      <!-- task: context documents -->
      <TaskContextDocs v-if="isTask" :block="block" />

      <!-- task: context issues (tracker) -->
      <TaskContextIssues v-if="isTask" :block="block" />

      <!-- service (frame): navigate the prescriptive spec tree (+ Gherkin scenarios when
           the spec is on the repo's default branch) -->
      <UButton
        v-if="isFrame"
        block
        color="neutral"
        variant="soft"
        size="sm"
        icon="i-lucide-scroll-text"
        @click="ui.openServiceSpec(block.id)"
      >
        View Requirements
      </UButton>

      <!-- service / module: tasks summary -->
      <ContainerSummary v-if="isContainer" :block="block" />
      <!-- service (frame): test infra + provisioning configuration -->
      <ServiceTestConfig v-if="isFrame" :block="block" />

      <!-- service (frame): best-practice fragments for code-aware agents -->
      <ServiceFragments v-if="isFrame" :block="block" />

      <!-- service (frame): post-release-health monitor/SLO mapping -->
      <ServiceReleaseHealthConfig v-if="isFrame" :block="block" />

      <!-- task: dependencies, structure, agent config, run settings, execution -->
      <template v-else-if="isTask">
        <RecurringScheduleSettings :block="block" />
        <TaskDependencies :block="block" />
        <TaskStructure :block="block" />
        <TaskAgentConfig :block="block" />
        <TaskEstimateBadge :block="block" />
        <TaskRunSettings :block="block" />
        <TaskExecution :block="block" />
      </template>

      <!-- epic: the full tree of member tasks, grouped by service → module -->
      <EpicChildren v-else-if="isEpic" :block="block" />

      <!-- actions -->
      <div class="flex items-center gap-2">
        <UDropdownMenu v-if="isTask" :items="runMenu">
          <UButton
            :color="runnable ? 'primary' : 'neutral'"
            variant="soft"
            size="sm"
            :icon="runnable ? 'i-lucide-play' : 'i-lucide-lock'"
            trailing-icon="i-lucide-chevron-down"
            :disabled="!runnable"
          >
            {{ instance ? 'Re-run' : 'Run' }}
          </UButton>
        </UDropdownMenu>
        <UButton
          v-if="isTask"
          color="neutral"
          variant="soft"
          size="sm"
          icon="i-lucide-maximize-2"
          @click="ui.focus(block.id)"
        >
          Focus
        </UButton>
        <UButton
          color="error"
          variant="ghost"
          size="sm"
          icon="i-lucide-trash-2"
          class="ml-auto"
          :title="deleteLabel"
          @click="remove"
        >
          {{ deleteLabel }}
        </UButton>
      </div>
    </div>
  </div>
</template>
