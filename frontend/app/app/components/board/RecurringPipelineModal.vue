<script setup lang="ts">
// Add a recurring pipeline to a service frame. Mirrors AddTaskModal: a button on
// the frame opens this, scoped to that frame (ui.addRecurringFrameId). The user
// names it, picks a pipeline + cadence, and the backend materialises one reused
// task block inside the frame that the schedule re-runs. When the Tech-debt
// pipeline is picked, the workspace issue-tracker choice is surfaced inline (it is
// where that pipeline files its ticket) and saved alongside.
import type { IssueIntakeConfig, Recurrence, ScheduleTemplate } from '~/types/recurring'
import type { TaskSourceKind } from '~/types/domain'
import type { IssueIntakeRefusalReason } from '@cat-factory/contracts'
import { BUILTIN_TASK_SOURCE_KINDS } from '@cat-factory/contracts'
import { apiErrorReason } from '~/composables/api/errors'
import { pipelineAllowedForSchedule } from '~/utils/pipeline'
import { appliesIntakePredicate } from '~/utils/intakePredicates'

const ui = useUiStore()
const board = useBoardStore()
const pipelines = usePipelinesStore()
const recurring = useRecurringPipelinesStore()
const tracker = useTrackerStore()
const tasks = useTasksStore()
const toast = useToast()
const { present } = usePipelineErrorToast()
const access = useWorkspaceAccess()
const { t, te } = useI18n()

const open = computed(() => ui.addRecurringFrameId !== null)

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
// A GitLab project is its full path with namespace, which NESTS (`group/sub/project`), so it is
// its own field rather than a reuse of the GitHub one: the two are not the same shape and the two
// providers read different legs of the stored board scope.
const intakeGitlabProject = ref('')
/**
 * The board scope for a DEPLOYMENT-REGISTERED source, held opaquely. Its own field rather than
 * reusing one of the three above, mirroring `issueIntakeConfigSchema.board.boardId`: only that
 * deployment's provider knows what its board id means, so the form carries the string and the
 * label stays generic.
 */
const intakeBoardId = ref('')

/**
 * Opt in to driving THIS schedule from tracker webhooks, for a pipeline that has no `bug-intake`
 * step. Enabling it also switches the schedule to on-demand, because the two are inseparable: a
 * cadence tick carries no triggering ticket, and the server refuses that combination.
 */
const trackerTrigger = ref(false)

function setTrackerTrigger(on: boolean): void {
  trackerTrigger.value = on
  if (on) onDemand.value = true
}

/**
 * On-demand is FORCED, not merely defaulted, while the tracker trigger is on: the server refuses a
 * per-ticket schedule that could also fire on a cadence, and setting the switch once at opt-in time
 * left the refusal reachable by turning it back off afterwards. The switch is disabled rather than
 * hidden, so the state it is locked into stays visible and the reason is stated beside it.
 */
const onDemandLocked = computed(() => trackerTrigger.value)

/**
 * Translated copy for a refused intake configuration, keyed off the backend's machine-readable
 * `details.reason`.
 *
 * The form makes both refusals unrepresentable, so this is the SECOND line rather than the first:
 * a stale form whose pipeline gained a `bug-intake` step since it opened, or an API client driving
 * the same endpoint, still reaches them, and the backend does not localize its prose. An EXHAUSTIVE
 * `Record` over the contracts union is the drift guard: a new refusal reason fails this typecheck
 * until it has copy, which a runtime `t()` lookup could not catch.
 */
const INTAKE_REFUSAL_KEYS: Record<IssueIntakeRefusalReason, string> = {
  per_ticket_requires_on_demand: 'board.recurring.refusalPerTicketRequiresOnDemand',
  per_ticket_conflicts_with_bug_intake: 'board.recurring.refusalPerTicketConflictsWithBugIntake',
}

function intakeRefusalCopy(error: unknown): string | null {
  const reason = apiErrorReason(error)
  if (!reason || !(reason in INTAKE_REFUSAL_KEYS)) return null
  // `te` before `t`, the `usePipelineErrorToast` idiom: a locale missing the key falls through to
  // the backend's prose rather than rendering the key path at the user.
  const key = INTAKE_REFUSAL_KEYS[reason as IssueIntakeRefusalReason]
  return te(key) ? t(key) : null
}

/**
 * Whether the picked source is one this build ships (and so has a vendor-specific board field).
 *
 * Read from the contracts constant rather than re-listing the three ids: the vocabulary has one
 * owner, and a fourth built-in source would otherwise render the opaque board field here while
 * every other surface offered its vendor one.
 */
const intakeSourceIsBuiltin = computed(() =>
  (BUILTIN_TASK_SOURCE_KINDS as readonly string[]).includes(intakeSource.value ?? ''),
)
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

// Hide a pipeline whose UI-testing step would REACH a frame with no UI (one scoped to a frontend
// service excuses itself) — it would be refused at run start.
// Also hide `'one-off'`-only pipelines: attaching one to a schedule is refused server-side.
const selectablePipelines = computed(() =>
  pipelines.pipelines.filter((p) => pipelineAllowedForSchedule(p, frame.value, board.blocks)),
)
const selectedPipeline = computed(() => pipelines.getPipeline(pipelineId.value))

/**
 * Whether a pipeline RUNS a step of this kind: present in its `agentKinds` AND not disabled.
 *
 * The three questions this modal asks about the picked pipeline (does it fish, does it file a
 * ticket, does it pull from the tracker) are the same question about three kinds, and each of
 * them has to honour the disabled half: a step somebody turned off imposes nothing, so demanding
 * its configuration would block a schedule on a step that will not run.
 */
function hasEnabledStep(
  pipeline: { agentKinds: string[]; enabled?: boolean[] } | null | undefined,
  kind: string,
): boolean {
  if (!pipeline) return false
  return pipeline.agentKinds.some((k, i) => k === kind && pipeline.enabled?.[i] !== false)
}

// Infer the template from the picked pipeline so the backend seeds the right block
// description (and so we know to show the tracker config).
//
// Only the pipelines whose SHAPE is specific to one kind of recurring work can be inferred this
// way. `dep-update` and `tech-debt` were both retired from the catalog (the first was the
// ordinary build tail under a recurring name, the second that tail behind an audit head), so
// those schedules now run an ordinary build rung — which is also what every generic schedule
// runs, so inferring a template from it would mislabel all of them. Both templates survive for an
// explicit API caller; see `scheduleTemplateSchema`.
//
// The expedition is read off its own step KIND rather than off `pl_bug_fishing`'s id, for the
// reason `filesTicket` below states: an id keys on the one preset that ships today and misses
// every pipeline a workspace composes around the same step, and the whole seed description is
// about what a `bug-fisher` pass does.
const isBugFishing = computed(() => hasEnabledStep(selectedPipeline.value, 'bug-fisher'))
const template = computed<ScheduleTemplate>(() =>
  isBugFishing.value
    ? 'bug-fishing'
    : pipelineId.value === 'pl_bug_triage'
      ? 'bug-triage'
      : 'custom',
)
/**
 * Whether the picked pipeline FILES a ticket (an enabled `tracker` step), so the schedule's first
 * run has somewhere to file it. Read off the pipeline's SHAPE, exactly as `isBugIntake` below is,
 * rather than off the inferred template: `pl_tech_debt` — the one preset this used to key on — was
 * retired, and what replaces it is a schedule pointed at a pipeline someone composed with an
 * `analysis` + `tracker` head. Keying on the id would have offered the tracker config to exactly
 * the one pipeline that no longer exists, and to none of the pipelines that now do this work.
 */
const filesTicket = computed(() => hasEnabledStep(selectedPipeline.value, 'tracker'))

// A pipeline whose ENABLED steps include `bug-intake` pulls its work from the tracker board, so
// the intake config is surfaced + required. Mirrors the backend `pipelineHasEnabledBugIntake`
// (a disabled step imposes nothing), so the modal doesn't demand config for a step that won't run.
const isBugIntake = computed(() => hasEnabledStep(selectedPipeline.value, 'bug-intake'))
/**
 * Whether the intake section is shown, and in which DISPATCH mode — both DERIVED from the picked
 * pipeline rather than chosen, because the two modes are not interchangeable:
 *
 *  - a `bug-intake` pipeline pulls its own work from the board, so a pushed event can only mean
 *    "drain the queue now" (`queue`);
 *  - any other pipeline has no step that picks work, so a pushed event can only mean "run THIS
 *    ticket" (`per-ticket`).
 *
 * Deriving it makes the combination the server refuses (`per-ticket` on a `bug-intake` pipeline)
 * unrepresentable here, instead of offering it and reporting a validation error afterwards.
 */
const showIntake = computed(() => isBugIntake.value || trackerTrigger.value)
const intakeDispatch = computed<'queue' | 'per-ticket'>(() =>
  isBugIntake.value ? 'queue' : 'per-ticket',
)

// Sources that can back intake right now: connected / App-installed AND enabled, AND able to run
// the predicate search intake fires. The last is not a refinement of the first two — a source
// without it saves a schedule that can never produce a ticket — so it is asked of the server
// (`supportsIntake`, derived from the registered provider) rather than inferred from the id here.
const intakeSources = computed(() => tasks.offeredSources.filter((s) => s.supportsIntake))

/** The selected source's state, which is what declares the predicates it will not apply. */
const intakeSourceState = computed(() =>
  intakeSource.value ? tasks.descriptorFor(intakeSource.value) : undefined,
)
const intakeSourceLabel = computed(() => intakeSourceState.value?.label ?? '')
/**
 * Whether the selected source will actually apply the issue-type predicate. A schedule fires
 * unattended, and `BugIntakeService` defaults the predicate to `bug`, so a source that drops it
 * starts the bugfix pipeline on whatever is oldest and open with nothing to point at.
 */
const intakeIssueTypeApplies = computed(() =>
  appliesIntakePredicate(intakeSourceState.value, 'issueType'),
)

watch(open, (isOpen) => {
  if (!isOpen) return
  name.value = ''
  description.value = ''
  // Default to the first schedulable pipeline, which is the ladder's own default rung. There is no
  // longer a canned recurring build preset to prefer — the dependency-update pipeline was the
  // ordinary build tail under another name — so the default build is the honest starting point.
  pipelineId.value = selectablePipelines.value[0]?.id ?? pipelines.pipelines[0]?.id ?? ''
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
  intakeGitlabProject.value = ''
  intakeBoardId.value = ''
  trackerTrigger.value = false
  intakeTitleFragment.value = ''
  intakeLabels.value = ''
  intakeIssueType.value = ''
  intakeInProgressLabel.value = ''
  // Load the connected task sources so the intake source picker is populated.
  void tasks.probe()
})

// UX-18: prompt before discarding typed input on Escape / backdrop / Cancel. Registered
// after the reset watcher so the baseline is the seeded form (the default pipeline + the
// workspace tracker settings are the clean starting point, not a spurious edit).
const { requestClose } = useUnsavedGuard({
  open,
  close: () => ui.closeAddRecurring(),
  saving: () => saving.value,
  snapshot: () => ({
    name: name.value.trim(),
    description: description.value.trim(),
    pipelineId: pipelineId.value,
    onDemand: onDemand.value,
    recurrence: recurrence.value,
    trackerKind: trackerKind.value,
    jiraProjectKey: jiraProjectKey.value.trim(),
    linearTeamId: linearTeamId.value.trim(),
    intakeSource: intakeSource.value,
    intakeJiraProjectKey: intakeJiraProjectKey.value.trim(),
    intakeLinearTeamId: intakeLinearTeamId.value.trim(),
    intakeGithubRepo: intakeGithubRepo.value.trim(),
    intakeGitlabProject: intakeGitlabProject.value.trim(),
    intakeBoardId: intakeBoardId.value.trim(),
    trackerTrigger: trackerTrigger.value,
    intakeTitleFragment: intakeTitleFragment.value.trim(),
    intakeLabels: intakeLabels.value.trim(),
    intakeIssueType: intakeIssueType.value.trim(),
    intakeInProgressLabel: intakeInProgressLabel.value.trim(),
  }),
})

// The template's v-model binding: dismissal (Escape / backdrop) routes through the guard.
// Declared after the guard so the setter's `requestClose` reference is never in its TDZ.
const modalOpen = computed({
  get: () => open.value,
  set: (v: boolean) => {
    if (!v) void requestClose()
  },
})

// The board field required for the picked source must be filled before a bug-intake schedule saves.
const intakeReady = computed(() => {
  if (!showIntake.value) return true
  if (intakeSource.value === 'jira') return intakeJiraProjectKey.value.trim().length > 0
  if (intakeSource.value === 'linear') return intakeLinearTeamId.value.trim().length > 0
  if (intakeSource.value === 'github') return intakeGithubRepo.value.trim().length > 0
  if (intakeSource.value === 'gitlab') return intakeGitlabProject.value.trim().length > 0
  // A registered source is scoped by its opaque board id. Falling through to `false` here would
  // make its schedule permanently unsaveable rather than merely unscoped.
  if (intakeSource.value) return intakeBoardId.value.trim().length > 0
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
      ...(source === 'gitlab' && intakeGitlabProject.value.trim()
        ? { gitlabProject: intakeGitlabProject.value.trim() }
        : {}),
      ...(!intakeSourceIsBuiltin.value && intakeBoardId.value.trim()
        ? { boardId: intakeBoardId.value.trim() }
        : {}),
    },
    predicates: {
      ...(intakeTitleFragment.value.trim()
        ? { titleFragment: intakeTitleFragment.value.trim() }
        : {}),
      ...(labels.length ? { labels } : {}),
      // Withheld for a source that would drop it anyway, so the STORED config carries no
      // predicate the schedule never applies: a config read back later is evidence of what the
      // schedule does, and a dead `issueType: 'bug'` on it is the same lie the form would tell.
      ...(intakeIssueTypeApplies.value && intakeIssueType.value.trim()
        ? { issueType: intakeIssueType.value.trim() }
        : {}),
    },
    ...(source === 'github' && intakeInProgressLabel.value.trim()
      ? { inProgressLabel: intakeInProgressLabel.value.trim() }
      : {}),
    // Sent only when it differs from the default, so an ordinary bug-intake schedule's stored
    // config is byte-for-byte what it was before the mode existed.
    ...(intakeDispatch.value === 'per-ticket' ? { dispatch: 'per-ticket' as const } : {}),
  }
}

const canAdd = computed(
  () =>
    name.value.trim().length > 0 &&
    pipelineId.value.length > 0 &&
    intakeReady.value &&
    // Scheduling a recurring pipeline is a `runs.execute` action.
    access.canExecuteRuns.value,
)

async function add() {
  const frameId = ui.addRecurringFrameId
  if (!frameId || !canAdd.value) return
  saving.value = true
  try {
    // Persist the tracker selection first when the tech-debt pipeline needs it, so
    // the very first run can file its ticket. This dialog decides WHERE a ticket is filed and
    // nothing about the writeback, so it names no writeback action and the stored ones stand.
    if (filesTicket.value && trackerKind.value) {
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
      ...(showIntake.value ? { issueIntake: buildIssueIntake() } : {}),
    })
    ui.closeAddRecurring()
  } catch (e) {
    const refusal = intakeRefusalCopy(e)
    if (refusal) {
      toast.add({
        title: t('board.recurring.addFailedTitle'),
        description: refusal,
        icon: 'i-lucide-triangle-alert',
        color: 'error',
      })
    } else present(e, 'board.recurring.addFailedTitle')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal v-model:open="modalOpen" :title="t('board.recurring.title')">
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

        <!-- The rich picker, not a name-only menu: which steps a schedule will run unattended,
             every time it fires, is exactly what the person setting it up needs to see. A schedule
             must name a pipeline, so there is no "none" row. -->
        <UFormField :label="t('board.recurring.pipeline')" required>
          <PipelinePicker
            v-model="pipelineId"
            :options="selectablePipelines"
            :placeholder="t('board.recurring.pickPipeline')"
            trigger-class="w-full justify-between"
          />
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
          <USwitch v-model="onDemand" :disabled="onDemandLocked" size="sm" class="mt-0.5" />
          <div class="space-y-0.5">
            <p class="text-xs font-medium text-slate-200">{{ t('board.recurring.onDemand') }}</p>
            <p class="text-[11px] text-slate-500">
              {{
                onDemandLocked
                  ? t('board.recurring.onDemandLockedHint')
                  : t('board.recurring.onDemandHint')
              }}
            </p>
          </div>
        </div>

        <RecurringRecurrenceEditor v-if="!onDemand" v-model="recurrence" />

        <div v-if="filesTicket" class="space-y-3 rounded-lg border border-slate-800 p-3">
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
              @click="
                () => {
                  trackerKind = 'github'
                }
              "
            >
              {{ t('board.recurring.githubIssues') }}
            </UButton>
            <UButton
              size="xs"
              :color="trackerKind === 'jira' ? 'primary' : 'neutral'"
              :variant="trackerKind === 'jira' ? 'solid' : 'subtle'"
              icon="i-lucide-square-check"
              @click="
                () => {
                  trackerKind = 'jira'
                }
              "
            >
              {{ t('board.recurring.jira') }}
            </UButton>
            <UButton
              size="xs"
              :color="trackerKind === 'linear' ? 'primary' : 'neutral'"
              :variant="trackerKind === 'linear' ? 'solid' : 'subtle'"
              icon="i-lucide-square-kanban"
              @click="
                () => {
                  trackerKind = 'linear'
                }
              "
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

        <!--
          A pipeline with no `bug-intake` step has no step that picks work, so tracker intake is an
          OPT-IN here: turning it on makes a matching webhook event run that ticket as its own task.
          A `bug-intake` pipeline needs no toggle — it cannot run without intake config at all.
        -->
        <div v-if="!isBugIntake" class="flex items-start gap-2">
          <USwitch
            :model-value="trackerTrigger"
            size="sm"
            class="mt-0.5"
            @update:model-value="setTrackerTrigger"
          />
          <div>
            <p class="text-xs font-medium text-slate-200">
              {{ t('board.recurring.trackerTrigger') }}
            </p>
            <p class="text-[11px] text-slate-500">
              {{ t('board.recurring.trackerTriggerHint') }}
            </p>
          </div>
        </div>

        <div v-if="showIntake" class="space-y-3 rounded-lg border border-slate-800 p-3">
          <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {{ t('board.recurring.intake') }}
          </p>
          <p class="text-[11px] text-slate-500">
            {{ t('board.recurring.intakeHint') }}
          </p>
          <!-- Two different remedies: connect something, versus connect something ELSE. A source
               that is connected but cannot run a scheduled search is not an absent connection. -->
          <p v-if="intakeSources.length === 0" class="text-[11px] text-amber-500">
            {{
              tasks.anyOffered
                ? t('board.recurring.intakeNoIntakeSources')
                : t('board.recurring.intakeNoSources')
            }}
          </p>
          <div v-else class="flex flex-wrap gap-1">
            <UButton
              v-for="s in intakeSources"
              :key="s.source"
              size="xs"
              :color="intakeSource === s.source ? 'primary' : 'neutral'"
              :variant="intakeSource === s.source ? 'solid' : 'subtle'"
              :icon="s.icon"
              @click="
                () => {
                  intakeSource = s.source
                }
              "
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
          <UFormField
            v-if="intakeSource === 'gitlab'"
            :label="t('board.recurring.intakeGitlabProject')"
            :help="t('board.recurring.intakeGitlabProjectHelp')"
            required
          >
            <!-- A GitLab project path is literal, and NESTS: subgroups are part of it. -->
            <UInput v-model="intakeGitlabProject" placeholder="group/project" class="w-full" />
          </UFormField>
          <UFormField
            v-if="intakeSource && !intakeSourceIsBuiltin"
            :label="t('board.recurring.intakeBoardId')"
            :help="t('board.recurring.intakeBoardIdHelp')"
            required
          >
            <UInput v-model="intakeBoardId" class="w-full" />
          </UFormField>

          <template v-if="intakeSource">
            <p class="text-[11px] text-slate-500">
              {{
                intakeDispatch === 'per-ticket'
                  ? t('board.recurring.intakeDispatchPerTicketHint')
                  : t('board.recurring.intakeDispatchQueueHint')
              }}
            </p>
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
              <UInput
                v-if="intakeIssueTypeApplies"
                v-model="intakeIssueType"
                placeholder="bug"
                class="w-full"
              />
              <!-- Not a disabled input: this source's provider never sends the predicate, so a box
                   still holding a value would read as a filter that is on. Stated here because a
                   schedule fires unattended — the only other evidence of the gap is a bugfix run
                   started on a docs chore. -->
              <p v-else class="text-xs text-amber-400">
                {{
                  t('board.recurring.intakeIssueTypeUnsupported', {
                    tracker: intakeSourceLabel,
                  })
                }}
              </p>
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
        <UButton color="neutral" variant="ghost" @click="requestClose()">{{
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
