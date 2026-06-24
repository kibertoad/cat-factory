<script setup lang="ts">
// Add a recurring pipeline to a service frame. Mirrors AddTaskModal: a button on
// the frame opens this, scoped to that frame (ui.addRecurringFrameId). The user
// names it, picks a pipeline + cadence, and the backend materialises one reused
// task block inside the frame that the schedule re-runs. When the Tech-debt
// pipeline is picked, the workspace issue-tracker choice is surfaced inline (it is
// where that pipeline files its ticket) and saved alongside.
import type { Recurrence, ScheduleTemplate } from '~/types/recurring'

const ui = useUiStore()
const board = useBoardStore()
const pipelines = usePipelinesStore()
const recurring = useRecurringPipelinesStore()
const tracker = useTrackerStore()
const toast = useToast()

const open = computed({
  get: () => ui.addRecurringFrameId !== null,
  set: (v: boolean) => {
    if (!v) ui.closeAddRecurring()
  },
})

const frame = computed(() =>
  ui.addRecurringFrameId ? board.getBlock(ui.addRecurringFrameId) : undefined,
)

const name = ref('')
const description = ref('')
const pipelineId = ref('')
const saving = ref(false)
const recurrence = ref<Recurrence>(defaultRecurrence())

// Tracker config (only relevant when the tech-debt pipeline is picked).
const trackerKind = ref<'github' | 'jira' | null>(null)
const jiraProjectKey = ref('')

function defaultRecurrence(): Recurrence {
  return {
    intervalHours: 168, // weekly
    weekdays: [],
    windowStartHour: null,
    windowEndHour: null,
    timezone: 'UTC',
  }
}

const pipelineMenu = computed(() => [
  pipelines.pipelines.map((p) => ({
    label: p.name,
    icon: 'i-lucide-workflow',
    onSelect: () => (pipelineId.value = p.id),
  })),
])
const selectedPipeline = computed(() => pipelines.getPipeline(pipelineId.value))
const selectedPipelineLabel = computed(() => selectedPipeline.value?.name ?? 'Pick a pipeline')

// Infer the template from the picked pipeline so the backend seeds the right block
// description (and so we know to show the tracker config).
const template = computed<ScheduleTemplate>(() => {
  if (pipelineId.value === 'pl_tech_debt') return 'tech-debt'
  if (pipelineId.value === 'pl_dep_update') return 'dep-update'
  return 'custom'
})
const isTechDebt = computed(() => template.value === 'tech-debt')

watch(open, (isOpen) => {
  if (!isOpen) return
  name.value = ''
  description.value = ''
  // Default to the Dependency-updates pipeline if present, else the first.
  pipelineId.value =
    pipelines.pipelines.find((p) => p.id === 'pl_dep_update')?.id ??
    pipelines.pipelines[0]?.id ??
    ''
  recurrence.value = defaultRecurrence()
  saving.value = false
  trackerKind.value = tracker.settings.tracker
  jiraProjectKey.value = tracker.settings.jiraProjectKey ?? ''
})

const canAdd = computed(() => name.value.trim().length > 0 && pipelineId.value.length > 0)

async function add() {
  const frameId = ui.addRecurringFrameId
  if (!frameId || !canAdd.value) return
  saving.value = true
  try {
    // Persist the tracker selection first when the tech-debt pipeline needs it, so
    // the very first run can file its ticket.
    if (isTechDebt.value && trackerKind.value) {
      await tracker.save({
        tracker: trackerKind.value,
        jiraProjectKey: trackerKind.value === 'jira' ? jiraProjectKey.value.trim() : null,
      })
    }
    await recurring.create({
      frameId,
      pipelineId: pipelineId.value,
      template: template.value,
      name: name.value.trim(),
      recurrence: recurrence.value,
      ...(description.value.trim() ? { description: description.value.trim() } : {}),
    })
    ui.closeAddRecurring()
  } catch (e) {
    toast.add({
      title: 'Could not add recurring pipeline',
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
  <UModal v-model:open="open" title="Add a recurring pipeline">
    <template #body>
      <div class="space-y-4">
        <p v-if="frame" class="text-xs text-slate-400">
          Recurring pipeline on
          <span class="font-medium text-slate-200">{{ frame.title }}</span>
        </p>

        <UFormField label="Name" required>
          <UInput
            v-model="name"
            placeholder="e.g. Weekly dependency updates"
            autofocus
            class="w-full"
          />
        </UFormField>

        <UFormField label="Pipeline" required>
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

        <UFormField label="Prompt">
          <UTextarea
            v-model="description"
            :rows="3"
            autoresize
            placeholder="What should each run do? Describe the work — the same prompt a normal task carries. Leave blank to use the pipeline's default."
            class="w-full"
          />
        </UFormField>

        <RecurringRecurrenceEditor v-model="recurrence" />

        <div v-if="isTechDebt" class="space-y-3 rounded-lg border border-slate-800 p-3">
          <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Issue tracker
          </p>
          <p class="text-[11px] text-slate-500">
            The tech-debt pipeline files a ticket from its analysis before implementing. Choose
            where (saved for the whole workspace).
          </p>
          <div class="flex gap-1">
            <UButton
              size="xs"
              :color="trackerKind === 'github' ? 'primary' : 'neutral'"
              :variant="trackerKind === 'github' ? 'solid' : 'subtle'"
              icon="i-lucide-github"
              @click="trackerKind = 'github'"
            >
              GitHub Issues
            </UButton>
            <UButton
              size="xs"
              :color="trackerKind === 'jira' ? 'primary' : 'neutral'"
              :variant="trackerKind === 'jira' ? 'solid' : 'subtle'"
              icon="i-lucide-square-check"
              @click="trackerKind = 'jira'"
            >
              Jira
            </UButton>
          </div>
          <UFormField v-if="trackerKind === 'jira'" label="Jira project key">
            <UInput v-model="jiraProjectKey" placeholder="e.g. ENG" class="w-full" />
          </UFormField>
        </div>

        <p class="text-[11px] text-slate-500">
          A single recurring task is added inside the service; each run replaces the last. Its run
          history is visible in the inspector.
        </p>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="ui.closeAddRecurring()">Cancel</UButton>
        <UButton
          color="primary"
          icon="i-lucide-repeat"
          :loading="saving"
          :disabled="!canAdd"
          @click="add"
        >
          Add recurring pipeline
        </UButton>
      </div>
    </template>
  </UModal>
</template>
