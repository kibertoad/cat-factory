<script setup lang="ts">
import type { Block } from '~/types/domain'
import { agentKindMeta } from '~/utils/catalog'
import { gateCompanionFor, COMPANION_STATE_META, isCompanionKind } from '~/utils/pipelineRender'
import AgentFailureCard from '~/components/board/AgentFailureCard.vue'

const props = defineProps<{ block: Block }>()

const execution = useExecutionStore()
const agentRuns = useAgentRunsStore()
const ui = useUiStore()
const models = useModelsStore()
const reviews = useReviewStage()

// The async stage this task's iterative reviewer gate (requirements-review / clarity-review)
// is mid-cycle in (folding the answers, then re-reviewing), or null. While set, the gate is
// doing background work and needs NO human, so its "Review" button is replaced by a working
// indicator.
const reviewStage = computed(() => reviews.stageForBlock(props.block.id))
const reviewStageLabel = computed(() =>
  reviewStage.value === 'incorporating'
    ? 'Incorporating…'
    : reviewStage.value === 'reviewing'
      ? 'Re-reviewing…'
      : reviewStage.value === 'recommending'
        ? 'Recommending…'
        : null,
)

const instance = computed(() => execution.getInstance(props.block.executionId))
// A failed run is no longer executing: a step left mid-flight must stop showing
// its live "Spinning up…" phase (the shared failure banner renders below).
const runFailed = computed(() => instance.value?.status === 'failed')

// A failed pipeline run surfaces the shared failure banner + retry — the
// execution failure surface that the old `pr_ready` flip used to hide.
const failedRun = computed(() => {
  const run = agentRuns.byBlock[props.block.id]
  return run && run.status === 'failed' ? run : null
})

const pr = computed(() => props.block.pullRequest)
/** A PR is merged once the block is `done`; otherwise it is open awaiting merge. */
const prMerged = computed(() => props.block.status === 'done')
const prLabel = computed(() => {
  const number = pr.value?.number
  return number ? `PR #${number}` : 'Pull request'
})

const stepLabel: Record<string, string> = {
  pending: 'Pending',
  working: 'Working',
  waiting_decision: 'Needs decision',
  done: 'Done',
}

/** A step left mid-flight (`working`) on a failed run gave up — not still working. */
function stepFailed(s: { state: string }) {
  return runFailed.value && s.state === 'working'
}

/** A gated step parked for approval reads "Needs approval", not "Needs decision". */
function labelForStep(s: {
  state: string
  agentKind?: string
  approval?: { status: string } | null
  companion?: { exceeded?: boolean } | null
  startingContainer?: boolean
}) {
  // A step left mid-flight on a failed run reads "Failed", not the misleading "Working".
  if (stepFailed(s)) return 'Failed'
  // A reviewer gate mid-cycle reads its working stage, not "Needs approval".
  if (reviews.isBackground(s.agentKind, props.block.id) && reviewStageLabel.value)
    return reviewStageLabel.value
  // A companion that spent its rework budget needs a decision, not an approval.
  if (s.approval?.status === 'pending' && s.companion?.exceeded) return 'Needs decision'
  if (s.approval?.status === 'pending') return 'Needs approval'
  // A container-backed step whose container is still cold-booting (only while the
  // run is live — a failed run's mid-flight step is no longer spinning up).
  if (s.startingContainer && !runFailed.value) return 'Spinning up…'
  return stepLabel[s.state]
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

// Stop the run WITHOUT deleting it: halts the container + driver and records a
// `cancelled` failure, leaving the run readable + retryable (the block goes
// `blocked`). The destructive reset (delete the run, return the task to `planned`)
// is a separate, explicit action.
const stopping = ref(false)
async function stopRun() {
  if (!instance.value || stopping.value) return
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
  resetting.value = true
  try {
    await execution.cancel(props.block.id)
  } finally {
    resetting.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
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
            title="Stop the run but keep it (readable + retryable)"
            @click="stopRun"
          >
            Stop
          </UButton>
          <!-- Destructive: discard the run and return the task to planned. -->
          <UButton
            icon="i-lucide-trash-2"
            color="error"
            variant="ghost"
            size="xs"
            :loading="resetting"
            :disabled="stopping"
            title="Discard this run and reset the task to planned"
            @click="resetRun"
          >
            Reset
          </UButton>
        </div>
      </div>
      <ul class="space-y-1">
        <li
          v-for="(s, i) in instance.steps"
          :key="i"
          class="rounded-md px-2 py-1"
          :class="i === instance.currentStep ? 'bg-slate-800/70' : ''"
        >
          <div class="flex items-center gap-2">
            <!-- Every agent is clickable: it opens the step-detail overlay (timing,
                 model, subtasks + the prose output when there is one). -->
            <button
              type="button"
              class="flex min-w-0 cursor-pointer items-center gap-2 text-left transition hover:text-white"
              :title="s.output ? 'View details & read output' : 'View step details'"
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
                title="Companion of a producer step"
              >
                Companion
              </span>
              <UIcon
                :name="s.output ? 'i-lucide-book-open-text' : 'i-lucide-info'"
                class="h-3.5 w-3.5 shrink-0 text-slate-500"
              />
            </button>
            <span
              v-if="s.subtasks && s.subtasks.total > 0"
              class="ml-auto font-mono text-[10px] tabular-nums text-slate-300"
              :title="
                s.subtasks.inProgress > 0
                  ? `${s.subtasks.completed} of ${s.subtasks.total} subtasks done, ${s.subtasks.inProgress} in progress`
                  : `${s.subtasks.completed} of ${s.subtasks.total} subtasks done`
              "
            >
              {{ s.subtasks.completed }}/{{ s.subtasks.total }}
            </span>
            <span
              class="inline-flex items-center gap-1 text-[10px]"
              :class="[
                stepFailed(s) ? 'text-rose-400' : 'text-slate-400',
                { 'ml-auto': !s.subtasks },
              ]"
            >
              <UIcon v-if="stepFailed(s)" name="i-lucide-circle-x" class="h-3 w-3 shrink-0" />
              {{ labelForStep(s) }}
            </span>
            <UButton
              v-if="s.decision && !s.decision.chosen"
              color="warning"
              variant="soft"
              size="xs"
              icon="i-lucide-circle-help"
              @click="openDecisionFor(s.decision.id)"
            >
              Resolve
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
              Decide
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
              {{ agentKindMeta(s.agentKind).resultView ? 'Review' : 'Approve' }}
            </UButton>
          </div>
          <div
            v-if="s.subtasks && s.subtasks.total > 0"
            class="mt-1 ml-6 h-1 overflow-hidden rounded-full bg-slate-700/60"
          >
            <div
              class="h-full rounded-full bg-indigo-400 transition-all duration-500"
              :style="{ width: `${(s.subtasks.completed / s.subtasks.total) * 100}%` }"
            />
          </div>
          <div
            v-if="s.model"
            class="mt-0.5 flex items-center gap-1 pl-6 text-[10px] text-slate-500"
            :title="s.model"
          >
            <UIcon name="i-lucide-cpu" class="h-3 w-3" />
            {{ models.labelForRef(s.model) }}
          </div>
          <!-- Prompt-fragment standards the library selected for this step. -->
          <div
            v-if="s.selectedFragmentIds && s.selectedFragmentIds.length"
            class="mt-0.5 flex flex-wrap items-center gap-1 pl-6 text-[10px] text-slate-500"
            :title="`Best-practice fragments folded into this step: ${s.selectedFragmentIds.join(', ')}`"
          >
            <UIcon name="i-lucide-book-marked" class="h-3 w-3 shrink-0" />
            <span>{{ s.selectedFragmentIds.length }} standard(s) applied</span>
          </div>
          <!-- Conditionally-run companion (the Tester's fixer): possible/running/
               completed/skipped, so it's clear whether a fix pass ran. -->
          <div
            v-if="gateCompanionFor(s, runFailed)"
            class="mt-0.5 flex items-center gap-1.5 pl-6 text-[10px]"
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
              {{ agentKindMeta(gateCompanionFor(s, runFailed)!.kind).label }} (companion)
            </span>
            <span
              class="ml-auto"
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

    <!-- Open PR: link straight to it on GitHub -->
    <div v-if="pr" class="space-y-2">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        Pull request
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
          <UBadge :color="prMerged ? 'success' : 'info'" variant="subtle" size="sm" class="ml-auto">
            {{ prMerged ? 'Merged' : 'Open' }}
          </UBadge>
        </span>
      </UButton>
      <p v-if="pr.branch" class="flex items-center gap-1 truncate text-[10px] text-slate-500">
        <UIcon name="i-lucide-git-branch" class="h-3 w-3 shrink-0" />
        <span class="truncate" :title="pr.branch">{{ pr.branch }}</span>
      </p>
    </div>

    <!-- PR ready: merge -->
    <UButton
      v-if="block.status === 'pr_ready'"
      color="success"
      variant="solid"
      size="sm"
      icon="i-lucide-git-merge"
      block
      @click="execution.mergePr(block.id)"
    >
      Merge PR
    </UButton>
  </div>
</template>
