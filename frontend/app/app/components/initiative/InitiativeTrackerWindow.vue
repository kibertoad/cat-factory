<script setup lang="ts">
// The initiative tracker window — the dedicated view of an initiative's plan/tracker
// entity: goal + constraints, the phases with their per-item status + PR links, the
// execution policy, and the decisions / deviations / follow-ups / caveats logs.
// Renders the DB entity (the source of truth) — never the in-repo mirror, which may
// not exist (GitHub-unwired workspaces). Opened via the universal result-view host:
// from the board card / inspector (`ui.openInitiativeTracker`) or as the planner
// step's result view. Live `initiative` stream events patch the store, so an open
// window follows the plan as it is ingested and later executed.
//
// It also OWNS the planner's plan-approval gate: this window is where the planner
// step's park routes (its archetype declares this result view), so the approve /
// request-changes rail has to live here or the gate has no resolving surface at all —
// which is exactly how an approved-only-over-REST plan gate shipped.
import { computed, reactive, ref } from 'vue'
import type { TableColumn } from '@nuxt/ui'
import type { InitiativeFollowUp, InitiativeItem } from '~/types/domain'
import { useInitiativePlanning } from '~/composables/useInitiativePlanning'
import {
  INITIATIVE_FOLLOWUP_STATUS_CHIPS,
  INITIATIVE_FOLLOWUP_STATUS_LABEL_KEYS,
  INITIATIVE_ITEM_STATUS_CHIPS,
  INITIATIVE_ITEM_STATUS_LABEL_KEYS,
  INITIATIVE_STATUS_LABEL_KEYS,
  initiativeProgress,
  pendingCheckpointPhase,
  planReviewDocument,
} from '~/utils/initiative'
import ResultWindowShell from '~/components/panels/ResultWindowShell.vue'
import StepRunMeta from '~/components/panels/StepRunMeta.vue'
import InitiativePlanReview from '~/components/initiative/InitiativePlanReview.vue'
import InitiativePlanNotice from '~/components/initiative/InitiativePlanNotice.vue'
import SectionLabel from '~/components/common/SectionLabel.vue'

const board = useBoardStore()
const initiatives = useInitiativesStore()
const access = useWorkspaceAccess()
const { t } = useI18n()
const { present } = usePipelineErrorToast()

const { open, blockId, instanceId, stepIndex, close } = useResultView('initiative-tracker', {
  onOpen: ({ blockId }) => void initiatives.load(blockId),
})

const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const initiative = computed(() => (blockId.value ? initiatives.forBlock(blockId.value) : null))

/**
 * The planning run's step this window speaks for, plus its run details, resolved through the
 * shared seam so the tracker reports the same "which run is this / how did the model do" facts as
 * every other agent window. The window is registered for the analyst, the planner AND the
 * (model-less) committer, and is reached from the board card / inspector as often as from the run
 * timeline — `useResultViewRunMeta` owns picking the right step for both cases.
 */
const {
  step: metaStep,
  instanceId: runId,
  position,
  totalSteps,
  runFailed,
  failureAt,
} = useResultViewRunMeta('initiative-tracker', {
  blockId: () => blockId.value,
  instanceId: () => instanceId.value,
  stepIndex: () => stepIndex.value,
})

/**
 * The `StepRunMeta` prop bundle, or null when no step speaks for this window. Bound as one object
 * because it has two homes — the tracker's end-side column, and the plan review's sidebar while the
 * review owns the window — and the run details must read identically in both.
 */
const runMeta = computed(() =>
  metaStep.value
    ? {
        step: metaStep.value,
        instanceId: runId.value,
        stepNumber: position.value,
        totalSteps: totalSteps.value,
        runFailed: runFailed.value,
        failureAt: failureAt.value,
      }
    : null,
)

const phases = computed(() => initiative.value?.phases ?? [])
function itemsOf(phaseId: string): InitiativeItem[] {
  return (initiative.value?.items ?? []).filter((i) => i.phaseId === phaseId)
}

// One column set for every phase's table, so the header typography is the table theme's rather
// than a per-file recipe.
const phaseItems = computed(() => phases.value.map((p) => ({ label: p.title, value: p.id })))

const itemColumns = computed<TableColumn<InitiativeItem>[]>(() => [
  { id: 'item', header: t('initiative.tracker.colItem') },
  { id: 'status', header: t('initiative.tracker.colStatus') },
  { id: 'pr', header: t('initiative.tracker.colPr') },
])

const progress = computed(() => initiativeProgress(initiative.value?.items))
const progressPct = computed(() =>
  progress.value && progress.value.total > 0
    ? Math.round((progress.value.settled / progress.value.total) * 100)
    : 0,
)

// Phase checkpoints (D2): the phase whose completed checkpoint is awaiting review (recomputed
// live from the entity — mirrors the loop's `pendingCheckpoint`), and whether the initiative is
// currently PAUSED at it. The tracker is the review surface: it shows the phase's committed
// artifacts + PRs, so a resume/cancel decision is taken right here.
const checkpointPhase = computed(() =>
  pendingCheckpointPhase(initiative.value?.phases, initiative.value?.items),
)
const pausedAtCheckpoint = computed(
  () => initiative.value?.status === 'paused' && checkpointPhase.value !== null,
)
// The phase whose checkpoint is genuinely holding the initiative RIGHT NOW (paused for review) —
// only then does its badge read "awaiting review". A phase whose items just settled but whose
// pause hasn't landed yet stays an upcoming checkpoint, so the badge can't get ahead of the banner.
const awaitingReviewPhaseId = computed(() =>
  pausedAtCheckpoint.value ? (checkpointPhase.value?.id ?? null) : null,
)

/** Resume (GO) or cancel (NO_GO) an initiative paused at a checkpoint. */
async function checkpointControl(action: 'resume' | 'cancel') {
  if (!blockId.value) return
  try {
    await initiatives.control(blockId.value, action)
  } catch (error) {
    reportError(error)
  }
}

// ---- Plan review: the planner step's human gate, resolved right here -----------------------
// Derived from the BLOCK (via the shared planning composable), not from this window's own
// `stepIndex`: the card / inspector open the tracker with no step, and that is the entry point a
// human parked on the gate actually uses. So the review appears on every route into the window.
const { planApproval } = useInitiativePlanning(() => blockId.value ?? '')

/**
 * The plan document the parked gate offers, or `''` — which is also the layout decision. A rendered
 * plan is a REPLACEMENT for the tracker body rather than a card above it: the render reads the
 * ingested entity, so the sections below would be a second copy of what the reviewer is reading,
 * and everything the tracker adds on top (PR links, item curation, checkpoints, follow-ups) is
 * execution-time state that cannot exist until the plan is committed. With no document, the tracker
 * body IS the plan, so the gate takes the compact notice above it instead.
 */
const planDocument = computed(() => planReviewDocument(planApproval.value))

/**
 * Confirm before discarding an in-progress plan review (UX-79). While a plan gate is parked this
 * window hands its whole body to `InitiativePlanReview`, which holds anchored per-block comments
 * and the overall feedback — the reviewer's actual work, held only in the browser until Send back
 * is pressed, on a surface Escape and a backdrop click both close. The review reports its own
 * dirtiness upward (it lives two components down); this is the only place that can act on it.
 *
 * The tracker body has two drafts of its own, and both are typed values held here until their OWN
 * Save: the follow-up promotion form's item title, and the policy form's two knobs (see
 * `promoteState` / `policyState` below for why each is measured against what it was SEEDED with).
 * The guard itself is registered at the bottom of this block, where all three are in scope.
 */
const planReviewDirty = ref(false)

const policyRules = computed(() => initiative.value?.policy?.rules ?? [])
function ruleAxes(rule: { minComplexity?: number; minRisk?: number; minImpact?: number }): string {
  const axes = [
    rule.minComplexity !== undefined
      ? t('initiative.tracker.axisComplexity', { value: rule.minComplexity })
      : null,
    rule.minRisk !== undefined ? t('initiative.tracker.axisRisk', { value: rule.minRisk }) : null,
    rule.minImpact !== undefined
      ? t('initiative.tracker.axisImpact', { value: rule.minImpact })
      : null,
  ].filter((a): a is string => a !== null)
  return axes.length ? axes.join(' · ') : t('initiative.tracker.axisNever')
}

// ---- Curation (slice 4): only meaningful while the initiative is still executing ----
const editable = computed(() => initiative.value?.status === 'executing')

/** Report a failed curation call as a toast (a stale-rev CAS conflict, an illegal edit, …). */
function reportError(error: unknown) {
  present(error, 'initiative.curation.failed')
}

// Follow-up promotion: an inline per-follow-up form (phase + optional title override).
const promotingId = ref<string | null>(null)
const promoteForm = reactive<{ phaseId: string; title: string }>({ phaseId: '', title: '' })
/**
 * What the promote form held the moment it opened.
 *
 * The unsaved guard below reports the form's DIVERGENCE from this rather than its contents, because
 * both of this window's inline forms are seeded from what is already stored: an opened-but-untouched
 * form is not unsaved work, and prompting over one would train the reader to dismiss the prompt.
 */
let promoteSeed = ''
function promoteState(): string {
  return JSON.stringify([promoteForm.phaseId, promoteForm.title])
}
/** The promote form's unsaved edit, or `''` when it is closed or untouched. */
function promoteDraft(): string {
  if (promotingId.value === null) return ''
  return promoteState() === promoteSeed ? '' : promoteState()
}

function startPromote(followUp: InitiativeFollowUp) {
  const sourcePhase = (initiative.value?.items ?? []).find(
    (i) => i.id === followUp.sourceItemId,
  )?.phaseId
  promoteForm.phaseId = sourcePhase ?? phases.value[0]?.id ?? ''
  promoteForm.title = followUp.title
  promoteSeed = promoteState()
  promotingId.value = followUp.id
}

async function submitPromote(followUp: InitiativeFollowUp) {
  if (!initiative.value || !promoteForm.phaseId) return
  try {
    await initiatives.promoteFollowUp(initiative.value.id, followUp.id, {
      phaseId: promoteForm.phaseId,
      ...(promoteForm.title.trim() && promoteForm.title.trim() !== followUp.title
        ? { title: promoteForm.title.trim() }
        : {}),
    })
    promotingId.value = null
  } catch (error) {
    reportError(error)
  }
}

async function dismissFollowUp(followUp: InitiativeFollowUp) {
  if (!initiative.value) return
  try {
    await initiatives.dismissFollowUp(initiative.value.id, followUp.id)
  } catch (error) {
    reportError(error)
  }
}

// Item status control: retry a blocked item, or skip a pending/blocked one.
async function itemAction(item: InitiativeItem, action: 'retry' | 'skip') {
  if (!initiative.value) return
  try {
    await initiatives.updateItem(initiative.value.id, item.id, { action })
  } catch (error) {
    reportError(error)
  }
}

// Policy editing: retune the two scalar knobs (concurrency + default pipeline) while preserving
// the planner-authored rules. A full rule editor stays out of scope — re-plan to reshape rules.
const editingPolicy = ref(false)
const policyForm = reactive<{ maxConcurrent: number; defaultPipelineId: string }>({
  maxConcurrent: 1,
  defaultPipelineId: '',
})
/** What the policy form held when it opened; see `promoteSeed` for why the guard compares to it. */
let policySeed = ''
function policyState(): string {
  return JSON.stringify([policyForm.maxConcurrent, policyForm.defaultPipelineId])
}
/** The policy form's unsaved edit, or `''` when it is closed or untouched. */
function policyDraft(): string {
  if (!editingPolicy.value) return ''
  return policyState() === policySeed ? '' : policyState()
}

function startEditPolicy() {
  const policy = initiative.value?.policy
  if (!policy) return
  policyForm.maxConcurrent = policy.maxConcurrent
  policyForm.defaultPipelineId = policy.defaultPipelineId
  policySeed = policyState()
  editingPolicy.value = true
}

async function savePolicy() {
  const policy = initiative.value?.policy
  if (!initiative.value || !policy) return
  try {
    await initiatives.updatePolicy(initiative.value.id, {
      ...policy,
      maxConcurrent: policyForm.maxConcurrent,
      defaultPipelineId: policyForm.defaultPipelineId.trim() || policy.defaultPipelineId,
    })
    editingPolicy.value = false
  } catch (error) {
    reportError(error)
  }
}

// Registered last on purpose: the snapshot reads the two inline forms above, and
// `useUnsavedGuard` takes its baseline synchronously, so a `ref` declared further down would still
// be in its temporal dead zone.
const { requestClose } = useUnsavedGuard({
  open,
  close: () => close(),
  snapshot: () => ({
    // Only meaningful while the review is the thing on screen; with no parked gate the body below
    // is what is rendered, and its own two forms are the drafts that count.
    planReview: planApproval.value && planDocument.value ? planReviewDirty.value : false,
    promote: promoteDraft(),
    policy: policyDraft(),
  }),
})
</script>

<template>
  <ResultWindowShell
    :open="open"
    icon="i-lucide-milestone"
    icon-class="bg-primary/15 text-primary"
    :title="initiative?.title ?? block?.title ?? t('initiative.tracker.title')"
    :subtitle="t('initiative.tracker.subtitle')"
    width="full"
    testid="initiative-tracker-window"
    @close="requestClose"
  >
    <template #header-extras>
      <div v-if="progress" class="flex items-center gap-2" data-testid="initiative-progress">
        <div class="h-1.5 w-24 overflow-hidden rounded-full bg-elevated">
          <div
            class="h-full rounded-full bg-app-success-500 transition-[width] duration-500"
            :style="{ width: `${progressPct}%` }"
          />
        </div>
        <span class="text-2xs tabular-nums text-muted">
          {{ t('initiative.card.progress', { done: progress.settled, total: progress.total }) }}
        </span>
      </div>
      <UBadge v-if="initiative" color="primary" variant="subtle" size="sm">
        {{ t(INITIATIVE_STATUS_LABEL_KEYS[initiative.status]) }}
      </UBadge>
    </template>

    <!-- The planner's human gate, with the plan rendered as a document. This window is where the
         park ROUTES (the planner's archetype declares this result view), so it is the only surface
         that can resolve it — and while it is parked the review OWNS the window: an outline sidebar,
         the plan at full height, per-block commenting and the commands in an end-side rail, the same
         tools and the same shape the step reader gives the architect's prose. The tracker body it
         replaces would only repeat the plan (see `planDocument`). -->
    <InitiativePlanReview
      v-if="planApproval && planDocument"
      :approval="planApproval.approval"
      :instance-id="planApproval.instanceId"
      :can-execute="access.canExecuteRuns.value"
      :plan-document="planDocument"
      @update:dirty="planReviewDirty = $event"
    >
      <template v-if="runMeta" #run-details>
        <StepRunMeta v-bind="runMeta" />
      </template>
    </InitiativePlanReview>

    <div v-else class="flex min-h-0 flex-1">
      <div class="min-w-0 flex-1 overflow-y-auto px-5 py-4">
        <!-- A parked gate whose step rendered no plan: the commands, plus a notice pointing at the
             sections below — which in that case are the only rendering of the plan there is.
             Deliberately OUTSIDE the entity branch: the gate lives on the RUN, so it is parked
             before `initiatives.load()` has resolved (and stays parked if it fails), and a window
             that answered such a gate with the empty state alone would leave it unresolvable from
             the UI. `hasSections` is what keeps the notice honest about whether the sections it
             points at are actually rendered underneath. -->
        <InitiativePlanNotice
          v-if="planApproval"
          :approval="planApproval.approval"
          :instance-id="planApproval.instanceId"
          :can-execute="access.canExecuteRuns.value"
          :has-sections="!!initiative"
        />

        <!-- No entity yet (module unwired / still creating). Centred in the column when it is the
             only thing in it; merely inset when the notice above it means `h-full` would overflow
             the scroller by the notice's own height. -->
        <div
          v-if="!initiative"
          class="flex flex-col items-center justify-center gap-2 text-center text-muted"
          :class="planApproval ? 'py-16' : 'h-full'"
        >
          <UIcon name="i-lucide-milestone" class="h-8 w-8 opacity-40" />
          <p class="text-sm">{{ t('initiative.tracker.empty') }}</p>
        </div>

        <template v-else>
          <!-- Paused at a phase checkpoint (D2): a completed checkpoint phase is awaiting
                   review before the next phase spawns. Read the phase's artifacts/PRs below,
                   then resume (continue) or cancel (stop) the initiative right here. -->
          <section
            v-if="pausedAtCheckpoint"
            class="mb-4 rounded-lg border border-app-warning-500/40 bg-app-warning-500/10 p-3.5"
            data-testid="initiative-checkpoint-pause"
          >
            <div class="flex items-start gap-2.5">
              <UIcon
                name="i-lucide-pause-circle"
                class="mt-0.5 h-4 w-4 shrink-0 text-app-warning-300"
              />
              <div class="min-w-0 flex-1">
                <h3 class="text-sm font-semibold text-app-warning-200">
                  {{ t('initiative.checkpoint.pausedTitle') }}
                </h3>
                <p class="mt-0.5 text-xs leading-relaxed text-app-warning-100/80">
                  {{ t('initiative.checkpoint.pausedBody', { phase: checkpointPhase!.title }) }}
                </p>
                <div class="mt-2.5 flex flex-wrap gap-2">
                  <UButton
                    color="neutral"
                    variant="ghost"
                    class="rounded bg-primary/90 px-2.5 py-1 text-2xs font-medium text-inverted hover:bg-primary disabled:opacity-50"
                    :disabled="initiatives.controlling"
                    data-testid="initiative-checkpoint-resume"
                    @click="checkpointControl('resume')"
                  >
                    {{ t('initiative.inspector.resume') }}
                  </UButton>
                  <UButton
                    color="neutral"
                    variant="ghost"
                    class="rounded border border-app-error-500/50 px-2.5 py-1 text-2xs font-medium text-app-error-300 hover:bg-app-error-500/10 disabled:opacity-50"
                    :disabled="initiatives.controlling"
                    data-testid="initiative-checkpoint-cancel"
                    @click="checkpointControl('cancel')"
                  >
                    {{ t('initiative.inspector.cancel') }}
                  </UButton>
                </div>
              </div>
            </div>
          </section>

          <!-- Goal & constraints. The planner's own prose, so it takes the reading measure the
               shell's `full` width obliges (see the `width` prop): the phase/item rows below are
               structure that reads better at the full span, but these are paragraphs and bullets
               of agent-written text that would otherwise run the width of the display. -->
          <section v-if="initiative.goal" class="mb-4">
            <SectionLabel as="h3" class="mb-1">
              {{ t('initiative.tracker.goal') }}
            </SectionLabel>
            <p class="max-w-3xl whitespace-pre-wrap text-sm leading-relaxed text-toned">
              {{ initiative.goal }}
            </p>
          </section>
          <section v-if="initiative.constraints?.length" class="mb-4">
            <SectionLabel as="h3" class="mb-1">
              {{ t('initiative.tracker.constraints') }}
            </SectionLabel>
            <ul class="max-w-3xl list-inside list-disc text-sm text-toned">
              <li v-for="(c, i) in initiative.constraints" :key="i">{{ c }}</li>
            </ul>
          </section>
          <section v-if="initiative.nonGoals?.length" class="mb-4">
            <SectionLabel as="h3" class="mb-1">
              {{ t('initiative.tracker.nonGoals') }}
            </SectionLabel>
            <ul class="max-w-3xl list-inside list-disc text-sm text-toned">
              <li v-for="(g, i) in initiative.nonGoals" :key="i">{{ g }}</li>
            </ul>
          </section>
          <section v-if="initiative.analysisSummary" class="mb-4">
            <SectionLabel as="h3" class="mb-1">
              {{ t('initiative.tracker.analysis') }}
            </SectionLabel>
            <p class="max-w-3xl whitespace-pre-wrap text-sm leading-relaxed text-toned">
              {{ initiative.analysisSummary }}
            </p>
          </section>

          <!-- Awaiting planning -->
          <div
            v-if="phases.length === 0"
            class="mb-4 rounded-lg border border-dashed border-muted p-4 text-center text-xs text-muted"
          >
            {{ t('initiative.tracker.noPlan') }}
          </div>

          <!-- Phases + items -->
          <section v-for="phase in phases" :key="phase.id" class="mb-5">
            <h3 class="mb-1 flex items-center gap-2 text-sm font-semibold text-default">
              <span>{{ t('initiative.tracker.phase', { title: phase.title }) }}</span>
              <!-- Checkpoint annotation (D2): this phase pauses the initiative for human review
                       once its items settle. Cleared → already reviewed; the pending one → awaiting
                       review; otherwise an upcoming gate. -->
              <UBadge
                v-if="phase.checkpoint"
                :color="
                  phase.checkpointClearedAt
                    ? 'neutral'
                    : awaitingReviewPhaseId === phase.id
                      ? 'warning'
                      : 'info'
                "
                variant="subtle"
                size="sm"
                :data-testid="`initiative-phase-checkpoint-${phase.id}`"
              >
                <UIcon name="i-lucide-flag" class="mr-1 h-3 w-3" />
                {{
                  phase.checkpointClearedAt
                    ? t('initiative.checkpoint.cleared')
                    : awaitingReviewPhaseId === phase.id
                      ? t('initiative.checkpoint.awaiting')
                      : t('initiative.checkpoint.badge')
                }}
              </UBadge>
            </h3>
            <p v-if="phase.goal" class="mb-2 text-xs text-muted">{{ phase.goal }}</p>
            <UTable
              :data="itemsOf(phase.id)"
              :columns="itemColumns"
              :ui="{
                root: 'overflow-x-auto rounded-lg border border-default',
                base: 'text-xs',
                td: 'px-3 py-2 text-xs whitespace-normal',
                empty: 'py-0',
                tr: 'align-top',
              }"
            >
              <template #item-cell="{ row }">
                <div class="font-medium text-default">{{ row.original.title }}</div>
                <div v-if="row.original.dependsOn?.length" class="mt-0.5 text-3xs text-dimmed">
                  {{
                    t('initiative.tracker.dependsOn', {
                      items: row.original.dependsOn.join(', '),
                    })
                  }}
                </div>
                <div
                  v-if="row.original.note"
                  class="mt-0.5 max-w-3xl text-3xs text-app-warning-300/80"
                >
                  {{ row.original.note }}
                </div>
                <div
                  v-if="
                    editable &&
                    (row.original.status === 'blocked' || row.original.status === 'pending')
                  "
                  class="mt-1 flex gap-1.5"
                >
                  <UButton
                    v-if="row.original.status === 'blocked'"
                    color="neutral"
                    variant="outline"
                    size="xs"
                    :label="t('initiative.curation.retry')"
                    :disabled="initiatives.curating"
                    :data-testid="`initiative-item-retry-${row.original.id}`"
                    @click="itemAction(row.original, 'retry')"
                  />
                  <UButton
                    color="neutral"
                    variant="outline"
                    size="xs"
                    :label="t('initiative.curation.skip')"
                    :disabled="initiatives.curating"
                    :data-testid="`initiative-item-skip-${row.original.id}`"
                    @click="itemAction(row.original, 'skip')"
                  />
                </div>
              </template>
              <template #status-cell="{ row }">
                <UBadge
                  :color="INITIATIVE_ITEM_STATUS_CHIPS[row.original.status]"
                  variant="subtle"
                  size="sm"
                >
                  {{ t(INITIATIVE_ITEM_STATUS_LABEL_KEYS[row.original.status]) }}
                </UBadge>
              </template>
              <template #pr-cell="{ row }">
                <ULink
                  raw
                  v-if="row.original.pr"
                  :to="row.original.pr.url"
                  target="_blank"
                  rel="noopener"
                  class="text-app-info-400 hover:underline"
                >
                  {{
                    row.original.pr.number
                      ? `#${row.original.pr.number}`
                      : t('initiative.tracker.prLink')
                  }}
                </ULink>
                <span v-else class="text-app-600">&mdash;</span>
              </template>
              <!-- The hand-built table rendered its header and no row; Nuxt UI's fallback is
                   an untranslated "No data.", so the slot states the same nothing. -->
              <template #empty />
            </UTable>
          </section>

          <!-- Execution policy -->
          <section v-if="initiative.policy" class="mb-4">
            <div class="mb-1 flex items-center gap-2">
              <SectionLabel as="h3">
                {{ t('initiative.tracker.policy') }}
              </SectionLabel>
              <UButton
                color="neutral"
                variant="ghost"
                v-if="editable && !editingPolicy"
                class="rounded border border-muted px-1.5 py-0.5 text-3xs text-toned hover:bg-elevated"
                data-testid="initiative-policy-edit"
                @click="startEditPolicy"
              >
                {{ t('initiative.curation.edit') }}
              </UButton>
            </div>
            <ul v-if="!editingPolicy" class="text-xs text-toned">
              <li>
                {{
                  t('initiative.tracker.maxConcurrent', {
                    count: initiative.policy.maxConcurrent,
                  })
                }}
              </li>
              <li v-for="(rule, i) in policyRules" :key="i">
                <code class="text-app-info-300">{{ rule.pipelineId }}</code>
                · {{ ruleAxes(rule) }}
              </li>
              <li>
                {{ t('initiative.tracker.defaultPipeline') }}
                <code class="text-app-info-300">{{ initiative.policy.defaultPipelineId }}</code>
              </li>
            </ul>
            <!-- Edit form: the two scalar knobs; planner-authored rules are preserved. -->
            <div v-else class="flex flex-col gap-2 rounded-lg border border-default p-3">
              <UFormField
                size="xs"
                :label="t('initiative.curation.maxConcurrentField')"
                :ui="{ root: 'flex items-center gap-2', label: 'w-40', container: 'mt-0' }"
              >
                <UInputNumber
                  v-model.optional="policyForm.maxConcurrent"
                  :min="1"
                  :max="20"
                  size="xs"
                  class="w-28"
                  data-testid="initiative-policy-max-concurrent"
                />
              </UFormField>
              <UFormField
                size="xs"
                :label="t('initiative.curation.defaultPipelineField')"
                :ui="{
                  root: 'flex items-center gap-2',
                  label: 'w-40',
                  container: 'flex-1 mt-0',
                }"
              >
                <UInput
                  v-model="policyForm.defaultPipelineId"
                  size="xs"
                  class="w-full"
                  :ui="{ base: 'font-mono' }"
                  data-testid="initiative-policy-default-pipeline"
                />
              </UFormField>
              <div class="flex gap-2">
                <UButton
                  color="neutral"
                  variant="ghost"
                  class="rounded bg-primary/90 px-2 py-1 text-2xs text-inverted hover:bg-primary disabled:opacity-50"
                  :disabled="initiatives.curating"
                  data-testid="initiative-policy-save"
                  @click="savePolicy"
                >
                  {{ t('initiative.curation.save') }}
                </UButton>
                <UButton
                  color="neutral"
                  variant="ghost"
                  class="rounded border border-muted px-2 py-1 text-2xs text-toned hover:bg-elevated"
                  @click="editingPolicy = false"
                >
                  {{ t('initiative.curation.cancel') }}
                </UButton>
              </div>
            </div>
          </section>

          <!-- Logs -->
          <section v-if="initiative.decisions?.length" class="mb-4">
            <SectionLabel as="h3" class="mb-1">
              {{ t('initiative.tracker.decisions') }}
            </SectionLabel>
            <ul class="list-inside list-disc text-sm text-toned">
              <li v-for="d in initiative.decisions" :key="d.id">
                <span class="font-medium">{{ d.title }}</span>
                <span v-if="d.detail" class="text-muted"> — {{ d.detail }}</span>
              </li>
            </ul>
          </section>
          <section v-if="initiative.deviations?.length" class="mb-4">
            <SectionLabel as="h3" class="mb-1">
              {{ t('initiative.tracker.deviations') }}
            </SectionLabel>
            <ul class="max-w-3xl list-inside list-disc text-sm text-toned">
              <li v-for="d in initiative.deviations" :key="d.id">
                <code v-if="d.itemId" class="text-muted">{{ d.itemId }}</code>
                {{ d.description }}
                <span v-if="d.resolution" class="text-muted"> → {{ d.resolution }}</span>
              </li>
            </ul>
          </section>
          <section v-if="initiative.followUps?.length" class="mb-4">
            <SectionLabel as="h3" class="mb-1">
              {{ t('initiative.tracker.followUps') }}
            </SectionLabel>
            <ul class="flex flex-col gap-2 text-sm text-toned">
              <li
                v-for="f in initiative.followUps"
                :key="f.id"
                class="rounded-lg border border-default p-2.5"
                :data-testid="`initiative-followup-${f.id}`"
              >
                <div class="flex items-start gap-2">
                  <div class="min-w-0 flex-1">
                    <span class="font-medium">{{ f.title }}</span>
                    <span v-if="f.detail" class="text-muted"> — {{ f.detail }}</span>
                  </div>
                  <UBadge
                    :color="INITIATIVE_FOLLOWUP_STATUS_CHIPS[f.status]"
                    variant="subtle"
                    size="sm"
                  >
                    {{ t(INITIATIVE_FOLLOWUP_STATUS_LABEL_KEYS[f.status]) }}
                  </UBadge>
                </div>
                <!-- Triage actions for an open follow-up (only while executing) -->
                <div v-if="editable && f.status === 'open'" class="mt-2">
                  <div v-if="promotingId === f.id" class="flex flex-col gap-2">
                    <UFormField
                      size="xs"
                      :label="t('initiative.curation.phaseField')"
                      :ui="{ root: 'flex items-center gap-2', container: 'flex-1 mt-0' }"
                    >
                      <USelect
                        v-model="promoteForm.phaseId"
                        :items="phaseItems"
                        size="xs"
                        class="w-full"
                        data-testid="initiative-promote-phase"
                      />
                    </UFormField>
                    <UInput
                      v-model="promoteForm.title"
                      size="xs"
                      :placeholder="t('initiative.curation.itemTitlePlaceholder')"
                      data-testid="initiative-promote-title"
                    />
                    <div class="flex gap-2">
                      <UButton
                        color="neutral"
                        variant="ghost"
                        class="rounded bg-primary/90 px-2 py-1 text-2xs text-inverted hover:bg-primary disabled:opacity-50"
                        :disabled="initiatives.curating || !promoteForm.phaseId"
                        data-testid="initiative-promote-submit"
                        @click="submitPromote(f)"
                      >
                        {{ t('initiative.curation.promoteConfirm') }}
                      </UButton>
                      <UButton
                        color="neutral"
                        variant="ghost"
                        class="rounded border border-muted px-2 py-1 text-2xs text-toned hover:bg-elevated"
                        @click="promotingId = null"
                      >
                        {{ t('initiative.curation.cancel') }}
                      </UButton>
                    </div>
                  </div>
                  <div v-else class="flex gap-1.5">
                    <UButton
                      color="neutral"
                      variant="ghost"
                      class="rounded border border-muted px-1.5 py-0.5 text-3xs text-toned hover:bg-elevated"
                      data-testid="initiative-followup-promote"
                      @click="startPromote(f)"
                    >
                      {{ t('initiative.curation.promote') }}
                    </UButton>
                    <UButton
                      color="neutral"
                      variant="ghost"
                      class="rounded border border-muted px-1.5 py-0.5 text-3xs text-toned hover:bg-elevated disabled:opacity-50"
                      :disabled="initiatives.curating"
                      data-testid="initiative-followup-dismiss"
                      @click="dismissFollowUp(f)"
                    >
                      {{ t('initiative.curation.dismiss') }}
                    </UButton>
                  </div>
                </div>
              </li>
            </ul>
          </section>
          <section v-if="initiative.caveats?.length" class="mb-4">
            <SectionLabel as="h3" class="mb-1">
              {{ t('initiative.tracker.caveats') }}
            </SectionLabel>
            <ul class="max-w-3xl list-inside list-disc text-sm text-toned">
              <li v-for="(c, i) in initiative.caveats" :key="i">{{ c }}</li>
            </ul>
          </section>
        </template>
      </div>

      <!-- Run details: the shared run-metadata + LLM model-activity block every agent window
           carries (step position, live duration, model, run id, calls + token usage). Resolved
           through `useResultViewRunMeta`, so it is present on the card / inspector entry point
           too — where this window carries no step index of its own. -->
      <aside
        v-if="runMeta"
        data-testid="initiative-tracker-run-meta"
        class="hidden w-60 shrink-0 flex-col gap-4 overflow-y-auto border-s border-default bg-default/50 px-4 py-4 lg:flex"
      >
        <StepRunMeta v-bind="runMeta" />
      </aside>
    </div>
  </ResultWindowShell>
</template>
