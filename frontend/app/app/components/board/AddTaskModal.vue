<script setup lang="ts">
// Create a new task on the board. The user names the task and writes its
// description themselves — there are no auto-generated placeholder titles. The
// task lands in `planned` state; it is never launched here. The user starts a
// pipeline on it explicitly (and can keep editing it until they do).
//
// The form also shows ungated "Context documents" / "Context issues" sections
// (mirroring the task inspector): an inline search picker (ContextDocumentPicker /
// ContextIssuePicker) finds already-imported items, search hits, or a pasted ref to
// attach as agent context. When the relevant integration isn't connected the Attach
// button is disabled with a hint. Linking needs the block id,
// so chosen items are staged locally and import-and-linked once the task is created
// (see useContextLinking) — the same context the agents see for every step of the run.
import type { CreateTaskType, TaskSourceKind, TaskTypeFields } from '~/types/domain'
import ContextDocumentPicker from '~/components/documents/ContextDocumentPicker.vue'
import ContextIssuePicker from '~/components/tasks/ContextIssuePicker.vue'

const ui = useUiStore()
const board = useBoardStore()
const documents = useDocumentsStore()
const tasks = useTasksStore()
const mergePresets = useMergePresetsStore()
const modelPresets = useModelPresetsStore()
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
// Whether the user marks this as a purely technical task up front (a refactor /
// non-functional change). Left off ⇒ the engine infers it from the spec phase.
const technical = ref(false)

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
    return typeof timeboxHours.value === 'number' &&
      Number.isFinite(timeboxHours.value) &&
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
const modelPresetId = ref('')
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

// Model preset: which model each agent runs on. Empty = workspace default preset.
const modelPresetMenu = computed(() => [
  [
    {
      label: modelPresets.defaultPreset
        ? `Default (${modelPresets.defaultPreset.name})`
        : 'Workspace default',
      icon: 'i-lucide-rotate-ccw',
      onSelect: () => (modelPresetId.value = ''),
    },
    ...modelPresets.presets.map((p) => ({
      label: p.name,
      icon: 'i-lucide-cpu',
      onSelect: () => (modelPresetId.value = p.id),
    })),
  ],
])
const selectedModelPresetLabel = computed(() => {
  if (!modelPresetId.value) {
    return modelPresets.defaultPreset
      ? `Default (${modelPresets.defaultPreset.name})`
      : 'Workspace default'
  }
  return modelPresets.presets.find((p) => p.id === modelPresetId.value)?.name ?? 'Workspace default'
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

// Context the user chose to attach to the new task (already-imported items + the
// import flow), committed once the block exists (see add() → linkPending).
const pendingContext = ref<PendingContext[]>([])

// The Context documents / Context issues sections mirror the task inspector but are
// always shown (ungated): when the relevant integration isn't connected the Attach
// button is disabled with a tooltip rather than the section being hidden.
const docsConnected = computed(() => documents.available && documents.anyConnected)
const issuesConnected = computed(() => tasks.available && tasks.anyOffered)
const pendingDocs = computed(() => pendingContext.value.filter((c) => c.kind === 'document'))
const pendingIssues = computed(() => pendingContext.value.filter((c) => c.kind === 'task'))

// Linked issues whose body is in hand, surfaced read-only above the description so the
// user SEES the original issue description is included in the task (and can add notes on
// top). The bodies are folded into the saved description on submit (see `add`).
const linkedIssueBodies = computed(() =>
  pendingIssues.value
    .filter((i) => (i.description ?? '').trim().length > 0)
    .map((i) => ({ key: contextKey(i), title: i.title, body: (i.description ?? '').trim() })),
)
const hasLinkedIssueBody = computed(() => linkedIssueBodies.value.length > 0)
// True while we're fetching a search-hit issue's body so the read-only preview can show
// a placeholder instead of silently appearing late.
const resolvingIssueBodies = ref(false)

// A staged issue picked from search results carries no body yet (`needsImport`, and the
// search result has no description). Resolve it once the form opens — from the local cache
// when already imported, else by importing it (idempotent; we'd import on add anyway) — so
// its description can be shown read-only and folded into the task. Best-effort: a failure
// just leaves that issue without a preview, still linked on add.
async function resolvePendingIssueBodies() {
  const unresolved = pendingContext.value.filter(
    (c) => c.kind === 'task' && !(c.description ?? '').trim(),
  )
  if (!unresolved.length) return
  resolvingIssueBodies.value = true
  try {
    const resolved: Record<string, string> = {}
    for (const item of unresolved) {
      const source = item.source as TaskSourceKind
      const cached = tasks.tasks.find(
        (t) => t.source === source && t.externalId === item.externalId,
      )
      if ((cached?.description ?? '').trim()) {
        resolved[contextKey(item)] = cached!.description
        continue
      }
      if (!item.needsImport) continue
      try {
        const imported = await tasks.importTask(source, item.externalId)
        if ((imported.description ?? '').trim()) resolved[contextKey(item)] = imported.description
      } catch {
        // Unreadable/forbidden issue — skip the preview; it still links on add.
      }
    }
    if (Object.keys(resolved).length) {
      // The issue is now imported, so it links directly on add (needsImport → false).
      pendingContext.value = pendingContext.value.map((c) => {
        const body = resolved[contextKey(c)]
        return body ? { ...c, description: body, needsImport: false } : c
      })
    }
  } finally {
    resolvingIssueBodies.value = false
  }
}

function addPending(item: PendingContext) {
  if (pendingContext.value.some((c) => contextKey(c) === contextKey(item))) return
  pendingContext.value = [...pendingContext.value, item]
}
function removePending(item: PendingContext) {
  pendingContext.value = pendingContext.value.filter((c) => contextKey(c) !== contextKey(item))
}

// Context documents and issues are both picked through an inline search picker
// (ContextDocumentPicker / ContextIssuePicker) rather than a dropdown that opens a
// second modal — stacked page-level modals don't interact here, which is why the
// old "Import a page…" / "Import an issue…" entries appeared to open something but
// nothing was clickable. The "Attach" button toggles the relevant picker open.
const showDocPicker = ref(false)
const chosenDocKeys = computed(() => pendingDocs.value.map(contextKey))
const showIssuePicker = ref(false)
const chosenIssueKeys = computed(() => pendingIssues.value.map(contextKey))

// Reset the form whenever the modal opens for a (new) container, and refresh the
// imported docs/issues so the quick-pick list is current.
watch(open, (isOpen) => {
  if (!isOpen) return
  title.value = ''
  description.value = ''
  saving.value = false
  taskType.value = 'feature'
  technical.value = false
  severity.value = ''
  stepsToReproduce.value = ''
  timeboxHours.value = undefined
  docKind.value = ''
  mergePresetId.value = ''
  modelPresetId.value = ''
  pipelineId.value = ''
  agentConfigValues.value = {}
  pendingContext.value = []
  showDocPicker.value = false
  showIssuePicker.value = false
  // Seed from a prefill when opened from another surface (e.g. "create task from
  // issue" sets the title + stages the issue as linked context). Pipeline / preset
  // are intentionally left at their defaults so the user confirms them here.
  const prefill = ui.addTaskPrefill
  if (prefill) {
    if (prefill.title) title.value = prefill.title
    if (prefill.description) description.value = prefill.description
    if (prefill.context?.length) pendingContext.value = [...prefill.context]
  }
  documents.loadDocuments().catch(() => {})
  tasks.loadTasks().catch(() => {})
  // Fetch any staged search-hit issue's body so its description shows read-only below.
  resolvePendingIssueBodies().catch(() => {})
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
    // The saved description includes each linked issue's body (shown read-only above)
    // followed by the user's own notes, so the original issue description is part of the
    // task — not only reachable via the context link.
    const notes = description.value.trim()
    const fullDescription =
      [...linkedIssueBodies.value.map((b) => b.body), notes].filter(Boolean).join('\n\n') ||
      undefined
    const block = await board.addTask(containerId, title.value.trim(), fullDescription, {
      taskType: taskType.value as CreateTaskType,
      ...(typeFields ? { taskTypeFields: typeFields } : {}),
      ...(mergePresetId.value ? { mergePresetId: mergePresetId.value } : {}),
      ...(modelPresetId.value ? { modelPresetId: modelPresetId.value } : {}),
      ...(pipelineId.value ? { pipelineId: pipelineId.value } : {}),
      ...(Object.keys(agentConfigValues.value).length
        ? { agentConfig: agentConfigValues.value }
        : {}),
      ...(technical.value ? { technical: true } : {}),
    })
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
        <div
          v-if="isRecurring"
          class="rounded-lg border border-slate-800 p-3 text-[11px] text-slate-400"
        >
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

          <!-- Linked issue description(s), read-only: shown so the user sees the original
               issue description is included in the task. It's folded into the saved
               description (before their notes) on add. -->
          <UFormField
            v-for="issue in linkedIssueBodies"
            :key="issue.key"
            :label="`${issue.title} (from issue, included)`"
          >
            <UTextarea
              :model-value="issue.body"
              :rows="4"
              autoresize
              readonly
              class="w-full"
              :ui="{ base: 'cursor-default text-slate-300' }"
            />
          </UFormField>
          <p v-if="resolvingIssueBodies" class="text-[11px] text-slate-500">
            Loading the linked issue's description…
          </p>

          <UFormField :label="hasLinkedIssueBody ? 'Additional notes' : 'Description'">
            <UTextarea
              v-model="description"
              :rows="4"
              autoresize
              :placeholder="
                hasLinkedIssueBody
                  ? 'Add anything else the agent should know — appended to the issue description above…'
                  : 'Describe the work — context, acceptance criteria, anything the agent should know…'
              "
              class="w-full"
            />
          </UFormField>

          <UCheckbox v-model="technical" name="technical">
            <template #label>
              <span class="text-sm text-slate-200">Technical task</span>
            </template>
            <template #description>
              <span class="text-[11px] text-slate-500">
                A refactor / non-functional / internal change. The implementer treats the task
                definition as primary and the spec as a regression reference; leave off to let the
                spec phase decide.
              </span>
            </template>
          </UCheckbox>

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

            <UFormField label="Model preset">
              <UDropdownMenu :items="modelPresetMenu" class="w-full">
                <UButton
                  color="neutral"
                  variant="subtle"
                  size="sm"
                  icon="i-lucide-cpu"
                  trailing-icon="i-lucide-chevron-down"
                  class="w-full justify-between"
                >
                  {{ selectedModelPresetLabel }}
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

          <!-- Context documents (ungated; Attach disabled until a source is connected). -->
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Context documents
              </span>
              <UButton
                v-if="docsConnected"
                color="neutral"
                variant="soft"
                size="xs"
                :icon="showDocPicker ? 'i-lucide-x' : 'i-lucide-plus'"
                @click="showDocPicker = !showDocPicker"
              >
                {{ showDocPicker ? 'Done' : 'Attach' }}
              </UButton>
              <UButton
                v-else
                color="neutral"
                variant="soft"
                size="xs"
                icon="i-lucide-plus"
                disabled
                :title="
                  documents.available
                    ? 'Connect a document source first (Integrations)'
                    : 'Enable the documents integration first'
                "
              >
                Attach
              </UButton>
            </div>
            <ContextDocumentPicker
              v-if="showDocPicker && docsConnected"
              :chosen-keys="chosenDocKeys"
              @pick="addPending"
            />
            <div v-if="pendingDocs.length" class="space-y-1">
              <div
                v-for="item in pendingDocs"
                :key="contextKey(item)"
                class="flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-300"
              >
                <UIcon
                  :name="item.icon ?? 'i-lucide-file-text'"
                  class="h-3.5 w-3.5 shrink-0 text-indigo-400"
                />
                <span class="truncate">{{ item.title }}</span>
                <UBadge
                  v-if="item.needsImport"
                  color="neutral"
                  variant="soft"
                  size="xs"
                  class="ml-1 shrink-0"
                >
                  imports on add
                </UBadge>
                <button
                  type="button"
                  class="ml-auto shrink-0 text-slate-400 hover:text-slate-200"
                  @click="removePending(item)"
                >
                  <UIcon name="i-lucide-x" class="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <p v-else class="text-[11px] text-slate-500">
              Attach a requirement, RFC or PRD so agents see it while implementing this task.
            </p>
          </div>

          <!-- Context issues (ungated; Attach disabled until a tracker is connected). -->
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Context issues
              </span>
              <UButton
                v-if="issuesConnected"
                color="neutral"
                variant="soft"
                size="xs"
                :icon="showIssuePicker ? 'i-lucide-x' : 'i-lucide-plus'"
                @click="showIssuePicker = !showIssuePicker"
              >
                {{ showIssuePicker ? 'Done' : 'Attach' }}
              </UButton>
              <UButton
                v-else
                color="neutral"
                variant="soft"
                size="xs"
                icon="i-lucide-plus"
                disabled
                :title="
                  tasks.available
                    ? 'Connect an issue tracker first (Integrations)'
                    : 'Enable the issue-tracker integration first'
                "
              >
                Attach
              </UButton>
            </div>
            <ContextIssuePicker
              v-if="showIssuePicker && issuesConnected"
              :chosen-keys="chosenIssueKeys"
              :scope-block-id="ui.addTaskContainerId ?? undefined"
              @pick="addPending"
            />
            <div v-if="pendingIssues.length" class="space-y-1">
              <div
                v-for="item in pendingIssues"
                :key="contextKey(item)"
                class="flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-300"
              >
                <UIcon
                  :name="item.icon ?? 'i-lucide-square-check'"
                  class="h-3.5 w-3.5 shrink-0 text-indigo-400"
                />
                <span class="truncate">{{ item.title }}</span>
                <UBadge
                  v-if="item.needsImport"
                  color="neutral"
                  variant="soft"
                  size="xs"
                  class="ml-1 shrink-0"
                >
                  imports on add
                </UBadge>
                <button
                  type="button"
                  class="ml-auto shrink-0 text-slate-400 hover:text-slate-200"
                  @click="removePending(item)"
                >
                  <UIcon name="i-lucide-x" class="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <p v-else class="text-[11px] text-slate-500">
              Attach a tracker issue so agents see its description and comments while implementing
              this task.
            </p>
          </div>

          <p class="text-[11px] text-slate-500">
            The task is added in a planned state. It won't run until you start a pipeline on it —
            you can keep editing it until then.
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
