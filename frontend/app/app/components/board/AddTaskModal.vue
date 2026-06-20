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
const ui = useUiStore()
const board = useBoardStore()
const documents = useDocumentsStore()
const tasks = useTasksStore()
const mergePresets = useMergePresetsStore()
const pipelines = usePipelinesStore()
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
  mergePresetId.value = ''
  pipelineId.value = ''
  pendingContext.value = []
  documents.loadDocuments().catch(() => {})
  tasks.loadTasks().catch(() => {})
})

const canAdd = computed(() => title.value.trim().length > 0)

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
