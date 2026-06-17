<script setup lang="ts">
import type { Block, BlockStatus } from '~/types/domain'
import { BLOCK_TYPE_META, STATUS_META } from '~/utils/catalog'
import TaskContextDocs from '~/components/documents/TaskContextDocs.vue'
import TaskContextIssues from '~/components/tasks/TaskContextIssues.vue'
import FeatureScenarios from '~/components/scenarios/FeatureScenarios.vue'
import ContainerSummary from '~/components/panels/inspector/ContainerSummary.vue'
import TaskDependencies from '~/components/panels/inspector/TaskDependencies.vue'
import TaskStructure from '~/components/panels/inspector/TaskStructure.vue'
import TaskModelSettings from '~/components/panels/inspector/TaskModelSettings.vue'
import TaskExecution from '~/components/panels/inspector/TaskExecution.vue'
import AgentFailureCard from '~/components/board/AgentFailureCard.vue'
import AgentStopButton from '~/components/board/AgentStopButton.vue'

const board = useBoardStore()
const pipelines = usePipelinesStore()
const execution = useExecutionStore()
const ui = useUiStore()
const documents = useDocumentsStore()
const tasks = useTasksStore()
const fragments = useFragmentsStore()
const models = useModelsStore()
const agentRuns = useAgentRunsStore()
const github = useGitHubStore()

onMounted(() => {
  fragments.ensureLoaded()
  models.ensureLoaded()
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

const instance = computed(() => execution.getInstance(block.value?.executionId))
const typeMeta = computed(() => (block.value ? BLOCK_TYPE_META[block.value.type] : null))

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

// The GitHub repo backing this service (a frame), if one is linked. Linkage lives
// on the github_repos projection (its `blockId`), not on the block itself.
const serviceRepo = computed(() =>
  isFrame.value && block.value ? github.repoForBlock(block.value.id) : undefined,
)
const serviceRepoUrl = computed(() =>
  serviceRepo.value ? github.repoUrl(serviceRepo.value.githubId) : null,
)

const runMenu = computed(() =>
  pipelines.pipelines.map((p) => ({
    label: p.name,
    icon: 'i-lucide-play',
    onSelect: () => block.value && execution.start(block.value.id, p),
  })),
)

function remove() {
  if (!block.value) return
  execution.cancel(block.value.id)
  board.removeBlock(block.value.id)
  ui.select(null)
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
</script>

<template>
  <div
    v-if="block && statusMeta && typeMeta"
    class="absolute right-4 top-4 z-20 w-80 overflow-hidden rounded-2xl border border-slate-700 bg-slate-900/95 shadow-2xl backdrop-blur"
  >
    <div class="h-1.5 w-full" :style="{ backgroundColor: statusMeta.color }" />
    <div class="space-y-4 p-4">
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

      <UTextarea
        v-model="block.description"
        :rows="2"
        autoresize
        size="sm"
        class="w-full"
        placeholder="Describe this block…"
      />

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
          v-if="tasks.available"
          color="neutral"
          variant="soft"
          size="xs"
          icon="i-lucide-ticket"
          @click="ui.openTaskImport()"
        >
          {{ tasks.anyConnected ? 'Import Jira issue' : 'Connect Jira' }}
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

      <!-- service / module: tasks summary -->
      <ContainerSummary v-if="isContainer" :block="block" />

      <!-- task: dependencies, structure, scenarios, run settings, execution -->
      <template v-else-if="isTask">
        <TaskDependencies :block="block" />
        <TaskStructure :block="block" />
        <FeatureScenarios :block="block" />
        <TaskModelSettings :block="block" />
        <TaskExecution :block="block" />
      </template>

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
          @click="remove"
        />
      </div>
    </div>
  </div>
</template>
