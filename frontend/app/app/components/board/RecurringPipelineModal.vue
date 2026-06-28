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
const { t } = useI18n()

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
const trackerKind = ref<'github' | 'jira' | 'linear' | null>(null)
const jiraProjectKey = ref('')
const linearTeamId = ref('')

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
const selectedPipelineLabel = computed(
  () => selectedPipeline.value?.name ?? t('board.recurring.pickPipeline'),
)

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
  linearTeamId.value = tracker.settings.linearTeamId ?? ''
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
        linearTeamId: trackerKind.value === 'linear' ? linearTeamId.value.trim() : null,
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
      title: t('board.recurring.addFailedTitle'),
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
  <UModal v-model:open="open" :title="t('board.recurring.title')">
    <template #body>
      <div class="space-y-4">
        <p v-if="frame" class="text-xs text-slate-400">
          <i18n-t keypath="board.recurring.on" tag="span" scope="global">
            <template #frame>
              <span class="font-medium text-slate-200">{{ frame.title }}</span>
            </template>
          </i18n-t>
        </p>

        <UFormField :label="t('board.recurring.name')" required>
          <UInput
            v-model="name"
            :placeholder="t('board.recurring.namePlaceholder')"
            autofocus
            class="w-full"
          />
        </UFormField>

        <UFormField :label="t('board.recurring.pipeline')" required>
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

        <UFormField :label="t('board.recurring.prompt')">
          <UTextarea
            v-model="description"
            :rows="3"
            autoresize
            :placeholder="t('board.recurring.promptPlaceholder')"
            class="w-full"
          />
        </UFormField>

        <RecurringRecurrenceEditor v-model="recurrence" />

        <div v-if="isTechDebt" class="space-y-3 rounded-lg border border-slate-800 p-3">
          <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {{ t('board.recurring.issueTracker') }}
          </p>
          <p class="text-[11px] text-slate-500">
            {{ t('board.recurring.issueTrackerHint') }}
          </p>
          <div class="flex gap-1">
            <UButton
              size="xs"
              :color="trackerKind === 'github' ? 'primary' : 'neutral'"
              :variant="trackerKind === 'github' ? 'solid' : 'subtle'"
              icon="i-lucide-github"
              @click="trackerKind = 'github'"
            >
              {{ t('board.recurring.githubIssues') }}
            </UButton>
            <UButton
              size="xs"
              :color="trackerKind === 'jira' ? 'primary' : 'neutral'"
              :variant="trackerKind === 'jira' ? 'solid' : 'subtle'"
              icon="i-lucide-square-check"
              @click="trackerKind = 'jira'"
            >
              {{ t('board.recurring.jira') }}
            </UButton>
            <UButton
              size="xs"
              :color="trackerKind === 'linear' ? 'primary' : 'neutral'"
              :variant="trackerKind === 'linear' ? 'solid' : 'subtle'"
              icon="i-lucide-square-kanban"
              @click="trackerKind = 'linear'"
            >
              {{ t('board.recurring.linear') }}
            </UButton>
          </div>
          <UFormField v-if="trackerKind === 'jira'" :label="t('board.recurring.jiraProjectKey')">
            <UInput
              v-model="jiraProjectKey"
              :placeholder="t('board.recurring.jiraProjectKeyPlaceholder')"
              class="w-full"
            />
          </UFormField>
          <UFormField v-if="trackerKind === 'linear'" :label="t('board.recurring.linearTeamId')">
            <UInput v-model="linearTeamId" placeholder="team_…" class="w-full" />
          </UFormField>
        </div>

        <p class="text-[11px] text-slate-500">
          {{ t('board.recurring.footerHint') }}
        </p>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="ui.closeAddRecurring()">{{
          t('common.cancel')
        }}</UButton>
        <UButton
          color="primary"
          icon="i-lucide-repeat"
          :loading="saving"
          :disabled="!canAdd"
          @click="add"
        >
          {{ t('board.recurring.submit') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
