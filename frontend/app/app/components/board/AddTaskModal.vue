<script setup lang="ts">
// Create a new task on the board. The user names the task and writes its
// description themselves — there are no auto-generated placeholder titles. The
// task lands in `planned` state; it is never launched here. The user starts a
// pipeline on it explicitly (and can keep editing it until they do).
//
// When the document/task integrations are available, the user can also attach
// external context up front via <ContextPicker>: search a connected source
// (Confluence / Notion / GitHub repo docs / Jira / GitHub issues) by title or
// content, paste a page/issue URL, or pick something already imported. Linking
// needs the block id, so we create the task first, then import-and-link the
// chosen items to it before closing — the same context the agents see for every
// step of the run (see the backend's linkedContextSection).
import type { CreateTaskType, TaskTypeFields } from '~/types/domain'

const ui = useUiStore()
const board = useBoardStore()
const documents = useDocumentsStore()
const tasks = useTasksStore()
const mergePresets = useMergePresetsStore()
const pipelines = usePipelinesStore()
const agentConfig = useAgentConfigStore()
const toast = useToast()

const { linkPending } = useContextLinking()

const open = computed({
  get: () => ui.addTaskContainerId !== null,
  set: (v: boolean) => {
    if (!v) ui.closeAddTask()
  },
})

const container = computed(() =>
  ui.addTaskContainerId ? board.getBlock(ui.addTaskContainerId) : undefined,
)

const title = ref('')
const description = ref('')
const saving = ref(false)

// The kind of task being created. `recurring` is special: it is created through the
// recurring-pipeline schedule flow (a schedule on the service frame), so picking it
// delegates to <RecurringPipelineModal> instead of creating a one-off task here.
type TaskTypeChoice = CreateTaskType | 'recurring'
const taskType = ref<TaskTypeChoice>('feature')
const TASK_TYPES: { value: TaskTypeChoice; label: string; icon: string }[] = [
  { value: 'feature', label: 'Feature', icon: 'i-lucide-sparkles' },
  { value: 'bug', label: 'Bug', icon: 'i-lucide-bug' },
  { value: 'document', label: 'Document', icon: 'i-lucide-file-text' },
  { value: 'spike', label: 'Spike', icon: 'i-lucide-flask-conical' },
  { value: 'recurring', label: 'Recurring', icon: 'i-lucide-repeat' },
]
const isRecurring = computed(() => taskType.value === 'recurring')

// Per-type fields (only the ones relevant to the chosen type are shown / sent).
const severity = ref<'low' | 'medium' | 'high' | 'critical' | ''>('')
const stepsToReproduce = ref('')
const timeboxHours = ref<number | undefined>(undefined)
const docKind = ref<'prd' | 'rfc' | 'runbook' | 'reference' | 'other' | ''>('')
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
const DOC_KINDS = ['prd', 'rfc', 'runbook', 'reference', 'other'] as const

function buildTypeFields(): TaskTypeFields | undefined {
  if (taskType.value === 'bug') {
    const f: TaskTypeFields = {}
    if (severity.value) f.severity = severity.value
    if (stepsToReproduce.value.trim()) f.stepsToReproduce = stepsToReproduce.value.trim()
    return Object.keys(f).length ? f : undefined
  }
  if (taskType.value === 'spike') {
    // `v-model.number` on a cleared number input yields '' (not undefined), which would
    // serialise as a non-number and 400 the create — so require a finite number here.
    return typeof timeboxHours.value === 'number' && Number.isFinite(timeboxHours.value) &&
      timeboxHours.value >= 0
      ? { timeboxHours: timeboxHours.value }
      : undefined
  }
  if (taskType.value === 'document') {
    return docKind.value ? { docKind: docKind.value } : undefined
  }
  return undefined
}

// For a recurring task, the schedule attaches to the service frame: the container itself
// when it's a frame, else its parent frame (a module's parent).
const recurringFrameId = computed(() => {
  const c = container.value
  if (!c) return null
  return c.level === 'frame' ? c.id : c.parentId
})

// Run configuration picked up front. Empty string = use the default (workspace
// default merge preset / no pinned pipeline).
const mergePresetId = ref('')
const pipelineId = ref('')

const presetMenu = computed(() => [
  [
    {
      label: mergePresets.defaultPreset
        ? `Default (${mergePresets.defaultPreset.name})`
        : 'Workspace default',
      icon: 'i-lucide-rotate-ccw',
      onSelect: () => (mergePresetId.value = ''),
    },
    ...mergePresets.presets.map((p) => ({
      label: p.name,
      icon: 'i-lucide-git-merge',
      onSelect: () => (mergePresetId.value = p.id),
    })),
  ],
])
const selectedPresetLabel = computed(() => {
  if (!mergePresetId.value) {
    return mergePresets.defaultPreset
      ? `Default (${mergePresets.defaultPreset.name})`
      : 'Workspace default'
  }
  return mergePresets.presets.find((p) => p.id === mergePresetId.value)?.name ?? 'Workspace default'
})

const pipelineMenu = computed(() => [
  [
    {
      label: 'Choose at run time',
      icon: 'i-lucide-rotate-ccw',
      onSelect: () => (pipelineId.value = ''),
    },
    ...pipelines.pipelines.map((p) => ({
      label: p.name,
      icon: 'i-lucide-workflow',
      onSelect: () => (pipelineId.value = p.id),
    })),
  ],
])
const selectedPipelineLabel = computed(
  () => pipelines.getPipeline(pipelineId.value)?.name ?? 'Choose at run time',
)

// Task-level agent config contributed by the selected pipeline's agents (e.g. the
// Tester's environment). Editable up front; persisted on the task and frozen once
// the contributing agent runs. Defaults to each descriptor's default until changed.
const agentConfigValues = ref<Record<string, string>>({})
const configDescriptors = computed(() => agentConfig.forPipeline(pipelineId.value))
function configValue(id: string, fallback: string): string {
  return agentConfigValues.value[id] ?? fallback
}
function setConfig(id: string, value: string) {
  agentConfigValues.value = { ...agentConfigValues.value, [id]: value }
}

// Context the user chose to attach to the new task (search hits, pasted URLs,
// already-imported items), collected by <ContextPicker> and committed on add.
const pendingContext = ref<PendingContext[]>([])

// The picker is offered whenever either integration is configured (even with
// nothing imported yet — you can search/paste a URL to attach the first item).
const showContext = computed(() => documents.available || tasks.available)

// Reset the form whenever the modal opens for a (new) container, and refresh the
// imported docs/issues so the quick-pick list is current.
watch(open, (isOpen) => {
  if (!isOpen) return
  title.value = ''
  description.value = ''
  saving.value = false
  taskType.value = 'feature'
  severity.value = ''
  stepsToReproduce.value = ''
  timeboxHours.value = undefined
  docKind.value = ''
  mergePresetId.value = ''
  pipelineId.value = ''
  agentConfigValues.value = {}
  pendingContext.value = []
  documents.loadDocuments().catch(() => {})
  tasks.loadTasks().catch(() => {})
})

// A recurring task only needs a target frame (its details are filled in the schedule
// modal); every other type needs a title.
const canAdd = computed(() =>
  isRecurring.value ? recurringFrameId.value !== null : title.value.trim().length > 0,
)

async function add() {
  const containerId = ui.addTaskContainerId
  if (!containerId || !canAdd.value) return
  // Recurring tasks are created via a schedule on the service frame — hand off to the
  // existing recurring-pipeline modal (which carries the cadence + prompt).
  if (isRecurring.value) {
    const frameId = recurringFrameId.value
    if (!frameId) return
    ui.closeAddTask()
    ui.openAddRecurring(frameId)
    return
  }
  saving.value = true
  try {
    const typeFields = buildTypeFields()
    const block = await board.addTask(
      containerId,
      title.value.trim(),
      description.value.trim() || undefined,
      {
        taskType: taskType.value as CreateTaskType,
        ...(typeFields ? { taskTypeFields: typeFields } : {}),
        ...(mergePresetId.value ? { mergePresetId: mergePresetId.value } : {}),
        ...(pipelineId.value ? { pipelineId: pipelineId.value } : {}),
        ...(Object.keys(agentConfigValues.value).length
          ? { agentConfig: agentConfigValues.value }
          : {}),
      },
    )
    if (block) {
      const failed = await linkPending(block.id, pendingContext.value)
      if (failed > 0) {
        toast.add({
          title: `Task added, but ${failed} attachment${failed === 1 ? '' : 's'} could not be linked`,
          icon: 'i-lucide-triangle-alert',
          color: 'warning',
        })
      }
    }
    ui.closeAddTask()
  } catch (e) {
    toast.add({
      title: 'Could not add task',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Add a task">
    <template #body>
      <div class="space-y-4">
        <p v-if="container" class="text-xs text-slate-400">
          New task in <span class="font-medium text-slate-200">{{ container.title }}</span>
        </p>

        <UFormField label="Type">
          <div class="flex flex-wrap gap-1">
            <UButton
              v-for="t in TASK_TYPES"
              :key="t.value"
              :color="taskType === t.value ? 'primary' : 'neutral'"
              :variant="taskType === t.value ? 'soft' : 'ghost'"
              :icon="t.icon"
              size="xs"
              @click="taskType = t.value"
            >
              {{ t.label }}
            </UButton>
          </div>
        </UFormField>

        <!-- Recurring tasks are configured as a schedule on the service frame. -->
        <div v-if="isRecurring" class="rounded-lg border border-slate-800 p-3 text-[11px] text-slate-400">
          <template v-if="recurringFrameId">
            A recurring task runs a pipeline on a cadence. Continue to set the schedule + prompt.
          </template>
          <template v-else>
            A recurring task must live on a service. Add it from a service frame (or a module inside
            one).
          </template>
        </div>

        <template v-if="!isRecurring">
        <UFormField label="Title" required>
          <UInput
            v-model="title"
            placeholder="What needs to be done?"
            autofocus
            class="w-full"
            @keydown.enter="add"
          />
        </UFormField>

        <UFormField label="Description">
          <UTextarea
            v-model="description"
            :rows="4"
            autoresize
            placeholder="Describe the work — context, acceptance criteria, anything the agent should know…"
            class="w-full"
          />
        </UFormField>

        <!-- Per-type fields. -->
        <div v-if="taskType === 'bug'" class="grid grid-cols-2 gap-3">
          <UFormField label="Severity">
            <div class="flex flex-wrap gap-1">
              <UButton
                v-for="s in SEVERITIES"
                :key="s"
                :color="severity === s ? 'primary' : 'neutral'"
                :variant="severity === s ? 'soft' : 'ghost'"
                size="xs"
                class="capitalize"
                @click="severity = severity === s ? '' : s"
              >
                {{ s }}
              </UButton>
            </div>
          </UFormField>
          <UFormField label="Steps to reproduce" class="col-span-2">
            <UTextarea
              v-model="stepsToReproduce"
              :rows="2"
              autoresize
              placeholder="Observed vs expected, and how to reproduce…"
              class="w-full"
            />
          </UFormField>
        </div>

        <UFormField v-else-if="taskType === 'spike'" label="Time-box (hours)">
          <UInput
            v-model.number="timeboxHours"
            type="number"
            min="0"
            placeholder="e.g. 8"
            class="w-full"
          />
        </UFormField>

        <UFormField v-else-if="taskType === 'document'" label="Document kind">
          <div class="flex flex-wrap gap-1">
            <UButton
              v-for="k in DOC_KINDS"
              :key="k"
              :color="docKind === k ? 'primary' : 'neutral'"
              :variant="docKind === k ? 'soft' : 'ghost'"
              size="xs"
              class="uppercase"
              @click="docKind = docKind === k ? '' : k"
            >
              {{ k }}
            </UButton>
          </div>
        </UFormField>

        <div class="grid grid-cols-2 gap-3">
          <UFormField label="Pipeline">
            <UDropdownMenu :items="pipelineMenu" class="w-full">
              <UButton
                color="neutral"
                variant="subtle"
                size="sm"
                icon="i-lucide-workflow"
                trailing-icon="i-lucide-chevron-down"
                class="w-full justify-between"
              >
                {{ selectedPipelineLabel }}
              </UButton>
            </UDropdownMenu>
          </UFormField>

          <UFormField label="Merge policy">
            <UDropdownMenu :items="presetMenu" class="w-full">
              <UButton
                color="neutral"
                variant="subtle"
                size="sm"
                icon="i-lucide-git-merge"
                trailing-icon="i-lucide-chevron-down"
                class="w-full justify-between"
              >
                {{ selectedPresetLabel }}
              </UButton>
            </UDropdownMenu>
          </UFormField>
        </div>

        <div v-if="configDescriptors.length" class="space-y-3">
          <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Agent configuration
          </span>
          <div v-for="d in configDescriptors" :key="d.id" class="space-y-1">
            <div class="text-[11px] text-slate-400">{{ d.label }}</div>
            <div class="flex flex-wrap gap-1">
              <UButton
                v-for="opt in d.options"
                :key="opt.value"
                :color="configValue(d.id, d.default) === opt.value ? 'primary' : 'neutral'"
                :variant="configValue(d.id, d.default) === opt.value ? 'soft' : 'ghost'"
                size="xs"
                @click="setConfig(d.id, opt.value)"
              >
                {{ opt.label }}
              </UButton>
            </div>
            <p class="text-[11px] leading-snug text-slate-500">{{ d.description }}</p>
          </div>
        </div>

        <div v-if="showContext" class="space-y-2">
          <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Extra context (optional)
          </span>

          <ContextPicker v-model="pendingContext" />

          <p class="text-[11px] text-slate-500">
            Search a connected source, paste a page/issue URL, or pick something already imported —
            it's fed to every agent step as context.
          </p>
        </div>

        <p class="text-[11px] text-slate-500">
          The task is added in a planned state. It won't run until you start a pipeline on it — you
          can keep editing it until then.
        </p>
        </template>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="ui.closeAddTask()">Cancel</UButton>
        <UButton
          color="primary"
          :icon="isRecurring ? 'i-lucide-arrow-right' : 'i-lucide-plus'"
          :loading="saving"
          :disabled="!canAdd"
          @click="add"
        >
          {{ isRecurring ? 'Continue' : 'Add task' }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
