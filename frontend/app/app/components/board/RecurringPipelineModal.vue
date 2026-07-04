<script setup lang="ts">
// Add a recurring pipeline to a service frame. Mirrors AddTaskModal: a button on
// the frame opens this, scoped to that frame (ui.addRecurringFrameId). The user
// names it, picks a pipeline + cadence, and the backend materialises one reused
// task block inside the frame that the schedule re-runs. When the Tech-debt
// pipeline is picked, the workspace issue-tracker choice is surfaced inline (it is
// where that pipeline files its ticket) and saved alongside.
import type { IssueIntakeConfig, Recurrence, ScheduleTemplate } from '~/types/recurring'
import type { TaskSourceKind } from '~/types/domain'
import { pipelineAllowedForSchedule } from '~/utils/pipeline'

const ui = useUiStore()
const board = useBoardStore()
const pipelines = usePipelinesStore()
const recurring = useRecurringPipelinesStore()
const tracker = useTrackerStore()
const tasks = useTasksStore()
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
// On-demand: no cadence, fires only via "run now". Because a person is present at fire time,
// its block may use an individual-usage subscription model (which a cadence schedule can't).
const onDemand = ref(false)

// Tracker config (only relevant when the tech-debt pipeline is picked).
const trackerKind = ref<'github' | 'jira' | 'linear' | null>(null)
const jiraProjectKey = ref('')
const linearTeamId = ref('')

// Issue-intake config (only relevant when the picked pipeline has a `bug-intake` step). Which
// tracker board + predicates a recurring bug-triage run pulls its one issue from, per-schedule.
const intakeSource = ref<TaskSourceKind | null>(null)
const intakeJiraProjectKey = ref('')
const intakeLinearTeamId = ref('')
const intakeGithubRepo = ref('')
const intakeTitleFragment = ref('')
const intakeLabels = ref('') // comma-separated in the UI, sent as an array
const intakeIssueType = ref('')
const intakeInProgressLabel = ref('')

function defaultRecurrence(): Recurrence {
  return {
    intervalHours: 168, // weekly
    weekdays: [],
    windowStartHour: null,
    windowEndHour: null,
    timezone: 'UTC',
  }
}

// Hide UI-testing pipelines when the frame has no UI to exercise — they'd be refused at run start.
// Also hide `'one-off'`-only pipelines: attaching one to a schedule is refused server-side.
const selectablePipelines = computed(() =>
  pipelines.pipelines.filter((p) => pipelineAllowedForSchedule(p, frame.value, board.blocks)),
)
const pipelineMenu = computed(() => [
  selectablePipelines.value.map((p) => ({
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

// A pipeline whose ENABLED steps include `bug-intake` pulls its work from the tracker board, so
// the intake config is surfaced + required. Mirrors the backend `pipelineHasEnabledBugIntake`
// (a disabled step imposes nothing), so the modal doesn't demand config for a step that won't run.
const isBugIntake = computed(() => {
  const pipeline = selectedPipeline.value
  if (!pipeline) return false
  return pipeline.agentKinds.some(
    (kind, i) => kind === 'bug-intake' && pipeline.enabled?.[i] !== false,
  )
})
// Sources that can back intake right now (connected / App-installed AND enabled).
const intakeSources = computed(() => tasks.offeredSources)

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
  onDemand.value = false
  saving.value = false
  trackerKind.value = tracker.settings.tracker
  jiraProjectKey.value = tracker.settings.jiraProjectKey ?? ''
  linearTeamId.value = tracker.settings.linearTeamId ?? ''
  intakeSource.value = null
  intakeJiraProjectKey.value = ''
  intakeLinearTeamId.value = ''
  intakeGithubRepo.value = ''
  intakeTitleFragment.value = ''
  intakeLabels.value = ''
  intakeIssueType.value = ''
  intakeInProgressLabel.value = ''
  // Load the connected task sources so the intake source picker is populated.
  void tasks.probe()
})

// The board field required for the picked source must be filled before a bug-intake schedule saves.
const intakeReady = computed(() => {
  if (!isBugIntake.value) return true
  if (intakeSource.value === 'jira') return intakeJiraProjectKey.value.trim().length > 0
  if (intakeSource.value === 'linear') return intakeLinearTeamId.value.trim().length > 0
  if (intakeSource.value === 'github') return intakeGithubRepo.value.trim().length > 0
  return false
})

function buildIssueIntake(): IssueIntakeConfig {
  const source = intakeSource.value as TaskSourceKind
  const labels = intakeLabels.value
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean)
  return {
    source,
    board: {
      ...(source === 'jira' && intakeJiraProjectKey.value.trim()
        ? { jiraProjectKey: intakeJiraProjectKey.value.trim() }
        : {}),
      ...(source === 'linear' && intakeLinearTeamId.value.trim()
        ? { linearTeamId: intakeLinearTeamId.value.trim() }
        : {}),
      ...(source === 'github' && intakeGithubRepo.value.trim()
        ? { githubRepo: intakeGithubRepo.value.trim() }
        : {}),
    },
    predicates: {
      ...(intakeTitleFragment.value.trim()
        ? { titleFragment: intakeTitleFragment.value.trim() }
        : {}),
      ...(labels.length ? { labels } : {}),
      ...(intakeIssueType.value.trim() ? { issueType: intakeIssueType.value.trim() } : {}),
    },
    ...(source === 'github' && intakeInProgressLabel.value.trim()
      ? { inProgressLabel: intakeInProgressLabel.value.trim() }
      : {}),
  }
}

const canAdd = computed(
  () => name.value.trim().length > 0 && pipelineId.value.length > 0 && intakeReady.value,
)

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
      // An on-demand schedule carries no cadence; a scheduled one sends its recurrence.
      onDemand: onDemand.value,
      ...(onDemand.value ? {} : { recurrence: recurrence.value }),
      ...(description.value.trim() ? { description: description.value.trim() } : {}),
      ...(isBugIntake.value ? { issueIntake: buildIssueIntake() } : {}),
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

        <div class="flex items-start gap-2 rounded-lg border border-slate-800 p-3">
          <USwitch v-model="onDemand" size="sm" class="mt-0.5" />
          <div class="space-y-0.5">
            <p class="text-xs font-medium text-slate-200">{{ t('board.recurring.onDemand') }}</p>
            <p class="text-[11px] text-slate-500">{{ t('board.recurring.onDemandHint') }}</p>
          </div>
        </div>

        <RecurringRecurrenceEditor v-if="!onDemand" v-model="recurrence" />

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

        <div v-if="isBugIntake" class="space-y-3 rounded-lg border border-slate-800 p-3">
          <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {{ t('board.recurring.intake') }}
          </p>
          <p class="text-[11px] text-slate-500">
            {{ t('board.recurring.intakeHint') }}
          </p>
          <p v-if="intakeSources.length === 0" class="text-[11px] text-amber-500">
            {{ t('board.recurring.intakeNoSources') }}
          </p>
          <div v-else class="flex flex-wrap gap-1">
            <UButton
              v-for="s in intakeSources"
              :key="s.source"
              size="xs"
              :color="intakeSource === s.source ? 'primary' : 'neutral'"
              :variant="intakeSource === s.source ? 'solid' : 'subtle'"
              :icon="s.icon"
              @click="intakeSource = s.source"
            >
              {{ s.label }}
            </UButton>
          </div>

          <UFormField
            v-if="intakeSource === 'jira'"
            :label="t('board.recurring.jiraProjectKey')"
            required
          >
            <UInput
              v-model="intakeJiraProjectKey"
              :placeholder="t('board.recurring.jiraProjectKeyPlaceholder')"
              class="w-full"
            />
          </UFormField>
          <UFormField
            v-if="intakeSource === 'linear'"
            :label="t('board.recurring.linearTeamId')"
            required
          >
            <UInput v-model="intakeLinearTeamId" placeholder="team_…" class="w-full" />
          </UFormField>
          <UFormField
            v-if="intakeSource === 'github'"
            :label="t('board.recurring.intakeGithubRepo')"
            required
          >
            <!-- A GitHub repo ref is always the literal `owner/name` path, never localized. -->
            <UInput v-model="intakeGithubRepo" placeholder="owner/name" class="w-full" />
          </UFormField>

          <template v-if="intakeSource">
            <UFormField :label="t('board.recurring.intakeTitleFragment')">
              <UInput
                v-model="intakeTitleFragment"
                :placeholder="t('board.recurring.intakeTitleFragmentPlaceholder')"
                class="w-full"
              />
            </UFormField>
            <UFormField :label="t('board.recurring.intakeLabels')">
              <UInput
                v-model="intakeLabels"
                :placeholder="t('board.recurring.intakeLabelsPlaceholder')"
                class="w-full"
              />
            </UFormField>
            <UFormField :label="t('board.recurring.intakeIssueType')">
              <!-- A literal issue-type example (tracker vocabulary), kept verbatim across locales. -->
              <UInput v-model="intakeIssueType" placeholder="bug" class="w-full" />
            </UFormField>
            <UFormField
              v-if="intakeSource === 'github'"
              :label="t('board.recurring.intakeInProgressLabel')"
            >
              <!-- A literal label example, kept verbatim across locales. -->
              <UInput v-model="intakeInProgressLabel" placeholder="in-progress" class="w-full" />
            </UFormField>
          </template>
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
