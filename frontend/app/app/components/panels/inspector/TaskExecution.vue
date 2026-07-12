<script setup lang="ts">
import type { Block } from '~/types/domain'
import { agentKindMeta } from '~/utils/catalog'
import {
  gateCompanionFor,
  COMPANION_STATE_META,
  isCompanionKind,
  containerPhaseLabel,
} from '~/utils/pipelineRender'
import AgentFailureCard from '~/components/board/AgentFailureCard.vue'
import AgentFailureHistory from '~/components/board/AgentFailureHistory.vue'
import EmptyState from '~/components/common/EmptyState.vue'
import InspectorSection from '~/components/panels/inspector/InspectorSection.vue'
import { useNowTick, stepDurationLabel } from '~/composables/useStepTimer'
import type { PipelineStep } from '~/types/execution'

const props = defineProps<{ block: Block }>()

const execution = useExecutionStore()
const agentRuns = useAgentRunsStore()
const ui = useUiStore()
const models = useModelsStore()
const reviews = useReviewStage()
const { t, te } = useI18n()
const { confirm } = useConfirm()

// The async stage this task's iterative reviewer gate (requirements-review / clarity-review)
// is mid-cycle in (folding the answers, then re-reviewing), or null. While set, the gate is
// doing background work and needs NO human, so its "Review" button is replaced by a working
// indicator.
const reviewStage = computed(() => reviews.stageForBlock(props.block.id))
const reviewStageLabel = computed(() =>
  reviewStage.value === 'incorporating'
    ? t('inspector.execution.stage.incorporating')
    : reviewStage.value === 'reviewing'
      ? t('inspector.execution.stage.reviewing')
      : reviewStage.value === 'recommending'
        ? t('inspector.execution.stage.recommending')
        : null,
)

const instance = computed(() => execution.getInstance(props.block.executionId))

// Nothing to show yet: no run, no failed run, no PR, and not awaiting a merge — render an
// empty state instead of a blank gap so the section reads as "no runs yet" rather than broken.
const isEmpty = computed(
  () =>
    !instance.value &&
    !failedRun.value &&
    !props.block.pullRequest &&
    props.block.status !== 'pr_ready',
)
// A failed run is no longer executing: a step left mid-flight must stop showing
// its live "Spinning up…" phase (the shared failure banner renders below).
const runFailed = computed(() => instance.value?.status === 'failed')

// A failed pipeline run surfaces the shared failure banner + retry — the
// execution failure surface that the old `pr_ready` flip used to hide.
const failedRun = computed(() => {
  const run = agentRuns.byBlock[props.block.id]
  return run && run.status === 'failed' ? run : null
})

// Failures from prior attempts, preserved across retries — shown regardless of the run's
// CURRENT status, so the error trail stays viewable after a restart clears the top banner.
const failureHistory = computed(() => agentRuns.byBlock[props.block.id]?.failureHistory ?? [])

const pr = computed(() => props.block.pullRequest)
/** A PR is merged once the block is `done`; otherwise it is open awaiting merge. */
const prMerged = computed(() => props.block.status === 'done')
const prLabel = computed(() => {
  const number = pr.value?.number
  return number
    ? t('inspector.execution.prNumber', { number })
    : t('inspector.execution.pullRequest')
})

const stepLabel: Record<string, string> = {
  pending: 'inspector.execution.stepState.pending',
  working: 'inspector.execution.stepState.working',
  waiting_decision: 'inspector.execution.stepState.waiting_decision',
  done: 'inspector.execution.stepState.done',
}

/** A step left mid-flight (`working`) on a failed run gave up — not still working. */
function stepFailed(s: { state: string }) {
  return runFailed.value && s.state === 'working'
}

// A shared 1s tick drives every step's live elapsed clock, so a running step that
// hasn't yet emitted subtask counts reads as progressing rather than hung.
const nowTick = useNowTick()
function stepElapsed(s: PipelineStep): string | null {
  return stepDurationLabel(s, nowTick.value, runFailed.value, instance.value?.failure?.occurredAt)
}

/** A gated step parked for approval reads "Needs approval", not "Needs decision". */
function labelForStep(s: {
  state: string
  agentKind?: string
  approval?: { status: string } | null
  companion?: { exceeded?: boolean } | null
  container?: { status: string; phase?: string | null } | null
}) {
  // A step left mid-flight on a failed run reads "Failed", not the misleading "Working".
  if (stepFailed(s)) return t('inspector.execution.failed')
  // A reviewer gate mid-cycle reads its working stage, not "Needs approval".
  if (reviews.isBackground(s.agentKind, props.block.id) && reviewStageLabel.value)
    return reviewStageLabel.value
  // A companion that spent its rework budget needs a decision, not an approval.
  if (s.approval?.status === 'pending' && s.companion?.exceeded)
    return t('inspector.execution.needsDecision')
  if (s.approval?.status === 'pending') return t('inspector.execution.needsApproval')
  // A container-backed step: surface its live lifecycle while the run is running. The
  // container is still cold-booting → "Spinning up"; up with a known phase → the phase
  // label ("Agent running" / "Preparing workspace"), so a finished cold-boot no longer
  // collapses into a blank "Working". A failed run's mid-flight step isn't booting.
  //
  // Only while the step is STILL RUNNING, though: the run's one shared container is kept
  // alive until the pipeline's final step, so a step that has already finished (e.g. the
  // merger, which resolves + advances to a trailing gate) would otherwise keep reading the
  // stale "Agent running" phase even though its state is `done`. A done step reads "Done".
  if (!runFailed.value && s.state !== 'done') {
    if (s.container?.status === 'starting') return t('inspector.execution.spinningUp')
    if (s.container?.status === 'up') {
      const label = containerPhaseLabel(s.container.phase, { t, te })
      if (label) return label
    }
  }
  const key = stepLabel[s.state]
  return key ? t(key) : s.state
}

function openDecisionFor(decisionId: string) {
  if (instance.value) ui.openDecision(instance.value.id, decisionId)
}

function openApprovalFor(approvalId: string) {
  if (instance.value) ui.openApprovalDetail(instance.value.id, approvalId)
}

// Clicking any agent opens its step-detail overlay — execution metadata (state,
// timing, model, subtasks) plus the full prose output when the agent produced one.
function openStep(i: number) {
  if (instance.value) ui.openStepDetail(instance.value.id, i)
}

// Open the implementation-fork decision window for a coder step parked awaiting a choice.
function openForkFor(i: number) {
  if (instance.value) ui.openForkDecision(instance.value.id, i)
}

// Stop the run WITHOUT deleting it: halts the container + driver and records a
// `cancelled` failure, leaving the run readable + retryable (the block goes
// `blocked`). The destructive reset (delete the run, return the task to `planned`)
// is a separate, explicit action.
const stopping = ref(false)
async function stopRun() {
  if (!instance.value || stopping.value) return
  // Killing the running container discards its in-flight work — gate it behind the same
  // confirm the board card's stop uses (via `AgentStopButton`), so every stop surface for
  // a run is confirm-gated identically.
  const ok = await confirm({
    title: t('board.stop.confirm.title'),
    description: t('board.stop.confirm.body'),
    confirmLabel: t('board.stop.confirm.confirm'),
    variant: 'destructive',
    icon: 'i-lucide-circle-stop',
  })
  if (!ok) return
  stopping.value = true
  try {
    await execution.stop(instance.value.id)
  } finally {
    stopping.value = false
  }
}
const resetting = ref(false)
async function resetRun() {
  if (resetting.value) return
  // Destructive: discards the run and returns the task to planned — gate it behind a confirm,
  // matching the confirm-then-mutate contract the board delete path uses.
  const ok = await confirm({
    title: t('inspector.execution.resetConfirm.title'),
    description: t('inspector.execution.resetConfirm.body'),
    variant: 'destructive',
    confirmLabel: t('inspector.execution.resetConfirm.confirm'),
    icon: 'i-lucide-trash-2',
  })
  if (!ok) return
  resetting.value = true
  try {
    await execution.cancel(props.block.id)
  } finally {
    resetting.value = false
  }
}

// Merging a PR is consequential and effectively irreversible — confirm first. `execution.mergePr`
// surfaces its own error toast, so no catch is needed here.
async function mergePr() {
  const ok = await confirm({
    title: t('inspector.execution.mergeConfirm.title'),
    description: t('inspector.execution.mergeConfirm.body'),
    confirmLabel: t('inspector.execution.mergeConfirm.confirm'),
    icon: 'i-lucide-git-merge',
  })
  if (!ok) return
  await execution.mergePr(props.block.id)
}
</script>

<template>
  <!-- The live run surface stays open by default: it is what a user selecting a
       running task is looking for (and what the e2e specs assert on). -->
  <InspectorSection
    :title="t('inspector.execution.title')"
    :hint="t('inspector.execution.hint')"
    default-open
  >
    <!-- running pipeline -->
    <div v-if="instance">
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {{ instance.pipelineName }}
        </span>
        <div class="flex items-center gap-1">
          <!-- Stop without deleting: halts the run but keeps it readable + retryable. -->
          <UButton
            icon="i-lucide-square"
            color="warning"
            variant="ghost"
            size="xs"
            :loading="stopping"
            :disabled="resetting"
            :title="t('inspector.execution.stopTooltip')"
            data-testid="run-stop"
            @click="stopRun"
          >
            {{ t('inspector.execution.stop') }}
          </UButton>
          <!-- Destructive: discard the run and return the task to planned. -->
          <UButton
            icon="i-lucide-trash-2"
            color="error"
            variant="ghost"
            size="xs"
            :loading="resetting"
            :disabled="stopping"
            :title="t('inspector.execution.resetTooltip')"
            data-testid="run-reset"
            @click="resetRun"
          >
            {{ t('inspector.execution.reset') }}
          </UButton>
        </div>
      </div>
      <ul class="space-y-1">
        <li
          v-for="(s, i) in instance.steps"
          :key="i"
          class="rounded-md px-2 py-1"
          :class="i === instance.currentStep ? 'bg-slate-800/70' : ''"
          data-testid="run-step"
          :data-step-kind="s.agentKind"
          :data-step-state="s.state"
        >
          <div class="flex items-center gap-2">
            <!-- Every agent is clickable: it opens the step-detail overlay (timing,
                 model, subtasks + the prose output when there is one). -->
            <button
              type="button"
              class="flex min-w-0 cursor-pointer items-center gap-2 text-start transition hover:text-white"
              :title="
                s.output
                  ? t('inspector.execution.viewDetailsOutput')
                  : t('inspector.execution.viewDetails')
              "
              @click="openStep(i)"
            >
              <UIcon
                :name="agentKindMeta(s.agentKind).icon"
                class="h-4 w-4 shrink-0"
                :style="{ color: agentKindMeta(s.agentKind).color }"
              />
              <span class="truncate text-xs text-slate-200">
                {{ agentKindMeta(s.agentKind).label }}
              </span>
              <span
                v-if="isCompanionKind(s.agentKind)"
                class="shrink-0 rounded bg-slate-700/60 px-1 text-[9px] font-medium uppercase tracking-wide text-slate-300"
                :title="t('inspector.execution.companionTooltip')"
              >
                {{ t('inspector.execution.companion') }}
              </span>
              <UIcon
                :name="s.output ? 'i-lucide-book-open-text' : 'i-lucide-info'"
                class="h-3.5 w-3.5 shrink-0 text-slate-500"
              />
            </button>
            <span
              v-if="s.subtasks && s.subtasks.total > 0"
              class="ms-auto font-mono text-[10px] tabular-nums text-slate-300"
              data-testid="run-subtasks"
              :title="
                s.subtasks.inProgress > 0
                  ? t('inspector.execution.subtasksProgress', {
                      completed: s.subtasks.completed,
                      total: s.subtasks.total,
                      inProgress: s.subtasks.inProgress,
                    })
                  : t('inspector.execution.subtasksDone', {
                      completed: s.subtasks.completed,
                      total: s.subtasks.total,
                    })
              "
            >
              {{ s.subtasks.completed }}/{{ s.subtasks.total }}
            </span>
            <span
              class="inline-flex items-center gap-1 text-[10px]"
              :class="[
                stepFailed(s) ? 'text-rose-400' : 'text-slate-400',
                { 'ms-auto': !s.subtasks },
              ]"
            >
              <UIcon v-if="stepFailed(s)" name="i-lucide-circle-x" class="h-3 w-3 shrink-0" />
              {{ labelForStep(s) }}
              <!-- live elapsed clock: a running step counts up, a finished one shows total -->
              <span
                v-if="stepElapsed(s)"
                class="inline-flex items-center gap-0.5 font-mono tabular-nums text-slate-500"
                :title="t('inspector.execution.elapsedTooltip')"
              >
                · {{ stepElapsed(s) }}
              </span>
            </span>
            <UButton
              v-if="s.decision && !s.decision.chosen"
              color="warning"
              variant="soft"
              size="xs"
              icon="i-lucide-circle-help"
              @click="openDecisionFor(s.decision.id)"
            >
              {{ t('inspector.execution.resolve') }}
            </UButton>
            <!-- reviewer gate folding/re-reviewing in the background: a working
                 indicator, NOT a "Review" gate (the human is summoned only if needed) -->
            <span
              v-else-if="reviews.isBackground(s.agentKind, block.id) && reviewStage"
              class="inline-flex shrink-0 items-center gap-1 text-[10px] text-indigo-300"
            >
              <UIcon name="i-lucide-loader-circle" class="h-3 w-3 animate-spin" />
              {{ reviewStageLabel }}
            </span>
            <!-- A companion that spent its rework budget parks on the iteration-cap
                 gate: it needs a 3-way DECISION (one more round / proceed / stop &
                 reset), not a plain approval — flag it distinctly so it can't read as
                 a normal "Approve". Opens the same detail surface (IterationCapPrompt). -->
            <UButton
              v-else-if="s.approval && s.approval.status === 'pending' && s.companion?.exceeded"
              color="error"
              variant="soft"
              size="xs"
              icon="i-lucide-alert-triangle"
              @click="openApprovalFor(s.approval.id)"
            >
              {{ t('inspector.execution.decide') }}
            </UButton>
            <!-- A coder step parked on the implementation-fork decision: pick an approach
                 (or enter a custom one) in the dedicated window, not a plain approval. -->
            <UButton
              v-else-if="
                s.approval &&
                s.approval.status === 'pending' &&
                s.forkDecision?.status === 'awaiting_choice'
              "
              color="primary"
              variant="soft"
              size="xs"
              icon="i-lucide-git-fork"
              @click="openForkFor(i)"
            >
              {{ t('inspector.execution.chooseApproach') }}
            </UButton>
            <UButton
              v-else-if="s.approval && s.approval.status === 'pending'"
              color="warning"
              variant="soft"
              size="xs"
              :icon="
                agentKindMeta(s.agentKind).resultView
                  ? 'i-lucide-clipboard-check'
                  : 'i-lucide-shield-check'
              "
              @click="openApprovalFor(s.approval.id)"
            >
              {{
                agentKindMeta(s.agentKind).resultView
                  ? t('inspector.execution.review')
                  : t('inspector.execution.approve')
              }}
            </UButton>
          </div>
          <div
            v-if="s.subtasks && s.subtasks.total > 0"
            class="mt-1 ms-6 h-1 overflow-hidden rounded-full bg-slate-700/60"
          >
            <div
              class="h-full rounded-full bg-indigo-400 transition-all duration-500"
              :style="{ width: `${(s.subtasks.completed / s.subtasks.total) * 100}%` }"
            />
          </div>
          <div
            v-if="s.model"
            class="mt-0.5 flex items-center gap-1 ps-6 text-[10px] text-slate-500"
            :title="s.model"
          >
            <UIcon name="i-lucide-cpu" class="h-3 w-3" />
            {{ models.labelForRef(s.model) }}
          </div>
          <!-- Prompt-fragment standards the library selected for this step. -->
          <div
            v-if="s.selectedFragmentIds && s.selectedFragmentIds.length"
            class="mt-0.5 flex flex-wrap items-center gap-1 ps-6 text-[10px] text-slate-500"
            :title="
              t('inspector.execution.fragmentsTooltip', {
                fragments: s.selectedFragmentIds.join(', '),
              })
            "
          >
            <UIcon name="i-lucide-book-marked" class="h-3 w-3 shrink-0" />
            <span>{{
              t(
                'inspector.execution.standardsApplied',
                { count: s.selectedFragmentIds.length },
                s.selectedFragmentIds.length,
              )
            }}</span>
          </div>
          <!-- Conditionally-run companion (the Tester's fixer): possible/running/
               completed/skipped, so it's clear whether a fix pass ran. -->
          <div
            v-if="gateCompanionFor(s, runFailed)"
            class="mt-0.5 flex items-center gap-1.5 ps-6 text-[10px]"
          >
            <UIcon
              :name="agentKindMeta(gateCompanionFor(s, runFailed)!.kind).icon"
              class="h-3 w-3 shrink-0"
              :class="[
                COMPANION_STATE_META[gateCompanionFor(s, runFailed)!.state].text,
                gateCompanionFor(s, runFailed)!.state === 'running' ? 'animate-spin' : '',
              ]"
            />
            <span class="text-slate-400">
              {{
                t('inspector.execution.companionOf', {
                  label: agentKindMeta(gateCompanionFor(s, runFailed)!.kind).label,
                })
              }}
            </span>
            <span
              class="ms-auto"
              :class="COMPANION_STATE_META[gateCompanionFor(s, runFailed)!.state].text"
            >
              {{ COMPANION_STATE_META[gateCompanionFor(s, runFailed)!.state].label }}
            </span>
          </div>
        </li>
      </ul>
    </div>

    <!-- failed run: shared failure banner + retry -->
    <AgentFailureCard v-if="failedRun" :run="failedRun" />

    <!-- error trail of prior attempts (survives a retry/restart that cleared the banner) -->
    <AgentFailureHistory :failures="failureHistory" />

    <!-- Open PR: link straight to it on GitHub -->
    <div v-if="pr" class="space-y-2">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {{ t('inspector.execution.pullRequest') }}
      </span>
      <UButton
        :to="pr.url"
        target="_blank"
        rel="noopener"
        external
        color="neutral"
        variant="soft"
        size="sm"
        icon="i-lucide-git-pull-request"
        trailing-icon="i-lucide-external-link"
        block
      >
        <span class="flex w-full items-center gap-2">
          {{ prLabel }}
          <UBadge :color="prMerged ? 'success' : 'info'" variant="subtle" size="sm" class="ms-auto">
            {{ prMerged ? t('inspector.execution.merged') : t('inspector.execution.open') }}
          </UBadge>
        </span>
      </UButton>
      <p v-if="pr.branch" class="flex items-center gap-1 truncate text-[10px] text-slate-500">
        <UIcon name="i-lucide-git-branch" class="h-3 w-3 shrink-0" />
        <span class="truncate" :title="pr.branch">{{ pr.branch }}</span>
      </p>
    </div>

    <!-- No run yet: read as "nothing here" rather than a blank gap. -->
    <EmptyState
      v-if="isEmpty"
      compact
      icon="i-lucide-play-circle"
      :title="t('inspector.execution.empty.title')"
      :description="t('inspector.execution.empty.body')"
    />

    <!-- PR ready: merge -->
    <UButton
      v-if="block.status === 'pr_ready'"
      color="success"
      variant="solid"
      size="sm"
      icon="i-lucide-git-merge"
      block
      @click="mergePr"
    >
      {{ t('inspector.execution.mergePr') }}
    </UButton>
  </InspectorSection>
</template>
