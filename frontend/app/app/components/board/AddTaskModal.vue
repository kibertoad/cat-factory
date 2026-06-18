<script setup lang="ts">
// Create a new task on the board. The user names the task and writes its
// description themselves — there are no auto-generated placeholder titles. The
// task lands in `planned` state; it is never launched here. The user starts a
// pipeline on it explicitly (and can keep editing it until they do).
//
// When the document/task integrations are available, the user can also attach
// already-imported documents (Confluence / Notion / …) and tracker issues (Jira
// / GitHub) as extra context up front. Linking needs the block id, so we create
// the task first, then link the selected items to it before closing — the same
// context the agents see for every step of the run (see the backend's
// linkedContextSection).
import type { SourceDocument, SourceTask } from '~/types/domain'

const ui = useUiStore()
const board = useBoardStore()
const documents = useDocumentsStore()
const tasks = useTasksStore()
const mergePresets = useMergePresetsStore()
const pipelines = usePipelinesStore()
const toast = useToast()

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

// Pending selections, keyed by `source:externalId` (stable across reloads).
const selectedDocs = ref<Set<string>>(new Set())
const selectedTasks = ref<Set<string>>(new Set())

const docKey = (d: Pick<SourceDocument, 'source' | 'externalId'>) => `${d.source}:${d.externalId}`
const taskKey = (t: Pick<SourceTask, 'source' | 'externalId'>) => `${t.source}:${t.externalId}`

const showContext = computed(
  () =>
    (documents.available && documents.documents.length > 0) ||
    (tasks.available && tasks.tasks.length > 0),
)

// Reset the form whenever the modal opens for a (new) container, and refresh the
// imported docs/issues so the latest are selectable.
watch(open, (isOpen) => {
  if (!isOpen) return
  title.value = ''
  description.value = ''
  saving.value = false
  mergePresetId.value = ''
  pipelineId.value = ''
  selectedDocs.value = new Set()
  selectedTasks.value = new Set()
  documents.loadDocuments().catch(() => {})
  tasks.loadTasks().catch(() => {})
})

function toggleDoc(key: string) {
  const next = new Set(selectedDocs.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  selectedDocs.value = next
}

function toggleTask(key: string) {
  const next = new Set(selectedTasks.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  selectedTasks.value = next
}

const canAdd = computed(() => title.value.trim().length > 0)

/** Link every selected doc/issue to the new block; returns how many failed. */
async function linkSelections(blockId: string): Promise<number> {
  let failed = 0
  for (const doc of documents.documents) {
    if (!selectedDocs.value.has(docKey(doc))) continue
    try {
      await documents.linkToBlock(blockId, doc.source, doc.externalId)
    } catch {
      failed++
    }
  }
  for (const task of tasks.tasks) {
    if (!selectedTasks.value.has(taskKey(task))) continue
    try {
      await tasks.linkToBlock(blockId, task.source, task.externalId)
    } catch {
      failed++
    }
  }
  return failed
}

async function add() {
  const containerId = ui.addTaskContainerId
  if (!containerId || !canAdd.value) return
  saving.value = true
  try {
    const block = await board.addTask(
      containerId,
      title.value.trim(),
      description.value.trim() || undefined,
      {
        ...(mergePresetId.value ? { mergePresetId: mergePresetId.value } : {}),
        ...(pipelineId.value ? { pipelineId: pipelineId.value } : {}),
      },
    )
    if (block) {
      const failed = await linkSelections(block.id)
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

        <div v-if="showContext" class="space-y-2">
          <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Extra context (optional)
          </span>

          <div v-if="documents.available && documents.documents.length" class="space-y-1">
            <button
              v-for="doc in documents.documents"
              :key="docKey(doc)"
              type="button"
              class="flex w-full items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-xs"
              :class="
                selectedDocs.has(docKey(doc))
                  ? 'border-indigo-500/60 bg-indigo-500/10 text-slate-200'
                  : 'border-slate-800 bg-slate-900/60 text-slate-300 hover:bg-slate-800/60'
              "
              @click="toggleDoc(docKey(doc))"
            >
              <UIcon
                :name="selectedDocs.has(docKey(doc)) ? 'i-lucide-check' : (documents.descriptorFor(doc.source)?.icon ?? 'i-lucide-file-text')"
                class="h-3.5 w-3.5 shrink-0 text-indigo-400"
              />
              <span class="truncate">{{ doc.title }}</span>
            </button>
          </div>

          <div v-if="tasks.available && tasks.tasks.length" class="space-y-1">
            <button
              v-for="task in tasks.tasks"
              :key="taskKey(task)"
              type="button"
              class="flex w-full items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-xs"
              :class="
                selectedTasks.has(taskKey(task))
                  ? 'border-indigo-500/60 bg-indigo-500/10 text-slate-200'
                  : 'border-slate-800 bg-slate-900/60 text-slate-300 hover:bg-slate-800/60'
              "
              @click="toggleTask(taskKey(task))"
            >
              <UIcon
                :name="selectedTasks.has(taskKey(task)) ? 'i-lucide-check' : (tasks.descriptorFor(task.source)?.icon ?? 'i-lucide-square-check')"
                class="h-3.5 w-3.5 shrink-0 text-indigo-400"
              />
              <span class="truncate">{{ task.externalId }} · {{ task.title }}</span>
              <UBadge color="neutral" variant="soft" size="xs" class="ml-auto shrink-0">
                {{ task.status }}
              </UBadge>
            </button>
          </div>

          <p class="text-[11px] text-slate-500">
            Attached documents and issues are fed to every agent step as context. Import more from
            the sidebar or the task inspector.
          </p>
        </div>

        <p class="text-[11px] text-slate-500">
          The task is added in a planned state. It won't run until you start a pipeline on it — you
          can keep editing it until then.
        </p>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="ui.closeAddTask()">Cancel</UButton>
        <UButton
          color="primary"
          icon="i-lucide-plus"
          :loading="saving"
          :disabled="!canAdd"
          @click="add"
        >
          Add task
        </UButton>
      </div>
    </template>
  </UModal>
</template>
