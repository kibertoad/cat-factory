<script setup lang="ts">
// Create a new task on the board. The user names the task and writes its
// description themselves — there are no auto-generated placeholder titles. The
// task lands in `planned` state; it is never launched here. The user starts a
// pipeline on it explicitly (and can keep editing it until they do).
const ui = useUiStore()
const board = useBoardStore()
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

// Reset the form whenever the modal opens for a (new) container.
watch(open, (isOpen) => {
  if (isOpen) {
    title.value = ''
    description.value = ''
    saving.value = false
  }
})

const canAdd = computed(() => title.value.trim().length > 0)

async function add() {
  const containerId = ui.addTaskContainerId
  if (!containerId || !canAdd.value) return
  saving.value = true
  try {
    await board.addTask(containerId, title.value.trim(), description.value.trim() || undefined)
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
