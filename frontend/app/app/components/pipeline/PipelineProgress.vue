<script setup lang="ts">
import type { AgentState, ExecutionInstance } from '~/types/domain'
import type { PipelineStep } from '~/types/execution'
import { agentKindMeta, FOLLOW_UP_COMPANION_META, FORK_DECISION_META } from '~/utils/catalog'
import {
  subtaskIconClass,
  gateCompanionFor,
  COMPANION_STATE_META,
  isCompanionKind,
  isFailedStep,
  FAILED_STEP_META,
  containerPhaseLabel,
} from '~/utils/pipelineRender'
import StepMetricsBar from '~/components/observability/StepMetricsBar.vue'
import { useNowTick, stepDurationLabel } from '~/composables/useStepTimer'

const props = defineProps<{ instance: ExecutionInstance }>()
const emit = defineEmits<{
  openDecision: [decisionId: string]
  openApproval: [approvalId: string]
}>()

const models = useModelsStore()
const ui = useUiStore()
const execution = useExecutionStore()
const reviews = useReviewStage()
const { t, te } = useI18n()

// The friendly container phase label for a step whose container is up — null otherwise.
// Lets the board fill the gap between the cold-boot badge clearing and the first subtask
// count (the old "blank working"). Shared with the step-detail card + inspector label.
function stepPhaseLabel(s: { container?: { status: string; phase?: string | null } | null }) {
  if (s.container?.status !== 'up') return null
  return containerPhaseLabel(s.container.phase, { t, te })
}

// While an iterative reviewer gate (requirements-review / clarity-review) folds the
// answers / re-reviews in the background it needs NO human, so its parked approval is
// replaced by a working indicator — the human is summoned again only if findings remain.
function reviewStageLabel(agentKind: string | undefined): string | null {
  if (!reviews.isBackground(agentKind, props.instance.blockId)) return null
  const stage = reviews.stageForBlock(props.instance.blockId)
  return stage === 'incorporating'
    ? t('pipeline.progress.stage.incorporating')
    : stage === 'reviewing'
      ? t('pipeline.progress.stage.reviewing')
      : stage === 'recommending'
        ? t('pipeline.progress.stage.recommending')
        : null
}

// Clicking an agent opens its step-detail overlay — execution metadata (state,
// timing, model, subtasks) plus the full prose output when the agent produced one.
function openStep(i: number) {
  ui.openStepDetail(props.instance.id, i)
}

// Follow-up companion (the future-looking Coder): how many surfaced items still need a
// decision, and the chip's roll-up label. The chip blinks while any item is pending.
function followUpPending(step: PipelineStep): number {
  return (step.followUps?.items ?? []).filter((it) => it.status === 'pending').length
}
function followUpLabel(step: PipelineStep): string {
  const items = step.followUps?.items ?? []
  if (items.length === 0) return t('pipeline.progress.followUp.watching')
  const pending = followUpPending(step)
  return pending > 0
    ? t('pipeline.progress.followUp.toDecide', { count: pending })
    : t('pipeline.progress.followUp.allDecided')
}

/** The active fork-decision phase status on a coder step (proposing / awaiting a choice). */
function forkPhase(step: PipelineStep): 'proposing' | 'awaiting_choice' | null {
  const status = step.forkDecision?.status
  return status === 'proposing' || status === 'awaiting_choice' ? status : null
}

// --- restart from a step -----------------------------------------------------
// Re-run the pipeline from a chosen step onward: the server resets that step +
// every later step's iteration counters and re-drives a fresh run, keeping the
// earlier steps' outputs as handoff context. Destructive (later results are
// dropped), so the hover button arms a two-click confirm. A step with its own
// unresolved approval is excluded — the approval rail owns that interaction.
const restartArmed = ref<number | null>(null)
const restarting = ref<number | null>(null)
function canRestart(s: ExecutionInstance['steps'][number]) {
  return !(s.approval && s.approval.status === 'pending')
}
async function restartFromHere(i: number) {
  if (restarting.value !== null) return
  restarting.value = i
  try {
    await execution.restartFromStep(props.instance.id, i)
  } finally {
    restarting.value = null
    restartArmed.value = null
  }
}

/** Visual language for an individual agent's runtime state. */
const STATE_META = computed<Record<AgentState, { label: string; color: string; icon: string }>>(
  () => ({
    pending: {
      label: t('pipeline.progress.state.pending'),
      color: '#64748b',
      icon: 'i-lucide-circle-dashed',
    },
    working: {
      label: t('pipeline.progress.state.working'),
      color: '#6366f1',
      icon: 'i-lucide-loader',
    },
    waiting_decision: {
      label: t('pipeline.progress.state.waiting_decision'),
      color: '#f59e0b',
      icon: 'i-lucide-circle-help',
    },
    done: {
      label: t('pipeline.progress.state.done'),
      color: '#22c55e',
      icon: 'i-lucide-circle-check',
    },
  }),
)

/** Visual language for the pipeline instance as a whole. */
const STATUS_META = computed<Record<ExecutionInstance['status'], { label: string; chip: string }>>(
  () => ({
    running: { label: t('pipeline.progress.status.running'), chip: 'primary' },
    blocked: { label: t('pipeline.progress.status.blocked'), chip: 'warning' },
    paused: { label: t('pipeline.progress.status.paused'), chip: 'neutral' },
    done: { label: t('pipeline.progress.status.done'), chip: 'success' },
    failed: { label: t('pipeline.progress.status.failed'), chip: 'error' },
  }),
)

const steps = computed(() => props.instance.steps)
const total = computed(() => steps.value.length)

// A shared 1s tick drives every step's live elapsed clock, so a step that hasn't yet
// emitted subtask counts still shows it is progressing rather than reading as hung.
const nowTick = useNowTick()
function stepElapsed(s: PipelineStep): string | null {
  return stepDurationLabel(s, nowTick.value, runFailed.value, props.instance.failure?.occurredAt)
}

// The conditionally-run companion (e.g. the Tester's `fixer`) each step drives, with
// its possible/running/completed/skipped state — rendered as a distinct sub-node so a
// human can see at a glance whether the fixer ran or was skipped.
const companionByStep = computed(() => steps.value.map((s) => gateCompanionFor(s, runFailed.value)))

// A failed run is no longer executing: a step left mid-flight (state still `working`,
// its container caught mid cold-boot) must stop looking live — no spinner, no pulse,
// no "spinning up container" phase.
const runFailed = computed(() => props.instance.status === 'failed')
/**
 * A reviewer gate (requirements-review / clarity-review) folding the answers or
 * re-reviewing in the durable driver: the step parks in `waiting_decision` but is actively
 * doing background LLM work and needs NO human, so it must read as working (a spinning
 * loader), not the waiting-for-a-human question mark.
 */
function backgroundReview(s: PipelineStep) {
  return reviews.isBackground(s.agentKind, props.instance.blockId)
}
/**
 * A step that is genuinely, currently working (not a stale mid-flight step) — including a
 * reviewer gate doing background fold/re-review work.
 */
function liveWorking(s: PipelineStep) {
  return (s.state === 'working' || backgroundReview(s)) && !runFailed.value
}
/**
 * The state visual (label/color/icon) for a step: a step left `working` when the run
 * failed reads as "Failed" with a red cross, not a frozen "Working" loader; a reviewer gate
 * mid background cycle reads as "Working" (a spinning loader), not "Needs decision".
 */
function stepVisual(s: PipelineStep) {
  if (isFailedStep(s.state, runFailed.value)) return FAILED_STEP_META
  if (backgroundReview(s)) return STATE_META.value.working
  return STATE_META.value[s.state]
}

/** A step counts as fully complete only once its state is `done`. */
const completedCount = computed(() => steps.value.filter((s) => s.state === 'done').length)

/** Effective 0..1 progress per step (a done step is always 100%). */
function stepProgress(state: AgentState, progress: number) {
  return state === 'done' ? 1 : progress
}

/** Overall pipeline progress: the mean of every step's effective progress. */
const overallProgress = computed(() => {
  if (!total.value) return 0
  const sum = steps.value.reduce((acc, s) => acc + stepProgress(s.state, s.progress), 0)
  return sum / total.value
})
const overallPct = computed(() => Math.round(overallProgress.value * 100))

const statusMeta = computed(() => STATUS_META.value[props.instance.status])

/** The agent the pipeline is currently centred on (for the summary line). */
const currentAgent = computed(() => {
  const s = steps.value[props.instance.currentStep]
  return s ? agentKindMeta(s.agentKind).label : null
})

/** Connector below a step is "lit" once that step has completed. */
function connectorDone(index: number) {
  return steps.value[index]?.state === 'done'
}

const legend: { state: AgentState }[] = [
  { state: 'done' },
  { state: 'working' },
  { state: 'waiting_decision' },
  { state: 'pending' },
]

// Icon per todo-item status, matching how the bootstrap card renders its
// subtask breakdown — so a zoomed-in task shows the same live todo list.
const ITEM_ICON: Record<string, string> = {
  completed: 'i-lucide-check-circle-2',
  in_progress: 'i-lucide-loader-circle',
  pending: 'i-lucide-circle',
}
</script>

<template>
  <div class="flex flex-col gap-5">
    <!-- summary -->
    <div class="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div class="flex flex-wrap items-center gap-3">
        <UBadge :color="statusMeta.chip as any" variant="subtle">{{ statusMeta.label }}</UBadge>
        <span class="text-sm text-slate-300">
          <i18n-t keypath="pipeline.progress.agentsComplete" tag="span" scope="global">
            <template #completed>
              <span class="font-semibold text-white">{{ completedCount }}</span>
            </template>
            <template #total>{{ total }}</template>
          </i18n-t>
        </span>
        <span v-if="currentAgent && instance.status === 'running'" class="text-xs text-slate-500">
          · {{ t('pipeline.progress.currently', { agent: currentAgent }) }}
        </span>
        <span class="ms-auto font-mono text-sm tabular-nums text-slate-200">{{
          t('pipeline.progress.percent', { value: overallPct })
        }}</span>
      </div>
      <UProgress :model-value="overallPct" class="mt-3" />

      <!-- legend -->
      <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span
          v-for="l in legend"
          :key="l.state"
          class="inline-flex items-center gap-1.5 text-[11px] text-slate-400"
        >
          <span
            class="h-2 w-2 rounded-full"
            :style="{ backgroundColor: STATE_META[l.state].color }"
          />
          {{ STATE_META[l.state].label }}
        </span>
      </div>
    </div>

    <!-- agent chain as a vertical timeline -->
    <ol class="flex flex-col">
      <li v-for="(s, i) in steps" :key="i" class="relative flex gap-4 pb-5 last:pb-0">
        <!-- connector line to the next step -->
        <span
          v-if="i < steps.length - 1"
          class="absolute top-9 bottom-0 start-[17px] w-0.5 -translate-x-1/2"
          :class="connectorDone(i) ? 'bg-emerald-500/60' : 'bg-slate-700'"
        />

        <!-- rail node -->
        <span
          class="relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 bg-slate-950"
          :class="liveWorking(s) ? 'step-active' : ''"
          :style="{ borderColor: stepVisual(s).color }"
        >
          <UIcon
            :name="stepVisual(s).icon"
            class="h-4 w-4"
            :class="liveWorking(s) ? 'animate-spin' : ''"
            :style="{ color: stepVisual(s).color }"
          />
        </span>

        <!-- step content card -->
        <div
          class="flex-1 rounded-xl border p-4 transition"
          :class="[
            i === instance.currentStep && instance.status !== 'done'
              ? 'border-indigo-500/70 bg-slate-900 shadow-lg shadow-indigo-500/10'
              : 'border-slate-800 bg-slate-900/50',
            s.state === 'pending' ? 'opacity-60' : '',
          ]"
        >
          <div
            class="group flex cursor-pointer items-center gap-2"
            :title="
              s.output
                ? t('pipeline.progress.viewDetailsOutput')
                : t('pipeline.progress.viewDetails')
            "
            @click="openStep(i)"
          >
            <div
              class="flex h-8 w-8 items-center justify-center rounded-lg"
              :style="{ backgroundColor: agentKindMeta(s.agentKind).color + '22' }"
            >
              <UIcon
                :name="agentKindMeta(s.agentKind).icon"
                class="h-4 w-4"
                :style="{ color: agentKindMeta(s.agentKind).color }"
              />
            </div>
            <div class="min-w-0">
              <div class="flex items-center gap-1.5">
                <span class="truncate text-sm font-semibold text-white">
                  {{ agentKindMeta(s.agentKind).label }}
                </span>
                <span
                  v-if="isCompanionKind(s.agentKind)"
                  class="shrink-0 rounded bg-slate-700/60 px-1 text-[9px] font-medium uppercase tracking-wide text-slate-300"
                  :title="t('pipeline.progress.companionTooltip')"
                >
                  {{ t('pipeline.progress.companion') }}
                </span>
              </div>
              <div
                class="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500"
              >
                <span>{{ t('pipeline.progress.stepOf', { current: i + 1, total }) }}</span>
                <!-- live elapsed clock: a running step counts up (so no-subtask steps
                     don't read as hung), a finished step shows its total duration -->
                <span
                  v-if="stepElapsed(s)"
                  class="inline-flex items-center gap-0.5 font-mono normal-case tabular-nums text-slate-400"
                  :title="t('pipeline.progress.elapsedTooltip')"
                >
                  <UIcon name="i-lucide-clock" class="h-2.5 w-2.5 shrink-0" />
                  {{ stepElapsed(s) }}
                </span>
              </div>
            </div>
            <span
              class="ms-auto shrink-0 text-[11px] font-medium"
              :style="{ color: stepVisual(s).color }"
            >
              {{ stepVisual(s).label }}
            </span>

            <!-- restart-from-here: revealed on row hover, arms a two-click confirm
                 (resetting later steps is destructive). Stops propagation so it
                 doesn't also open the step-detail overlay. -->
            <template v-if="canRestart(s)">
              <UButton
                v-if="restartArmed !== i"
                icon="i-lucide-rotate-ccw"
                color="neutral"
                variant="ghost"
                size="xs"
                class="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                :title="t('pipeline.progress.restartTooltip')"
                @click.stop="
                  () => {
                    restartArmed = i
                  }
                "
              />
              <template v-else>
                <UButton
                  color="warning"
                  variant="soft"
                  size="xs"
                  icon="i-lucide-rotate-ccw"
                  :loading="restarting === i"
                  class="shrink-0"
                  @click.stop="restartFromHere(i)"
                >
                  {{ t('pipeline.progress.restartFromHere') }}
                </UButton>
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  class="shrink-0"
                  :disabled="restarting === i"
                  @click.stop="
                    () => {
                      restartArmed = null
                    }
                  "
                >
                  {{ t('common.cancel') }}
                </UButton>
              </template>
            </template>

            <UIcon
              :name="s.output ? 'i-lucide-book-open-text' : 'i-lucide-info'"
              class="h-4 w-4 shrink-0 text-slate-500 transition-colors group-hover:text-indigo-300"
            />
          </div>

          <!-- per-step progress (only while it has meaningful progress) -->
          <UProgress
            v-if="s.state === 'working' || s.state === 'done'"
            :model-value="Math.round(stepProgress(s.state, s.progress) * 100)"
            size="xs"
            class="mt-3"
          />

          <!-- container cold-boot phase: shown while the container is spinning up. -->
          <div
            v-if="s.container?.status === 'starting' && !runFailed"
            class="mt-2 flex items-center gap-1.5 text-[11px] text-sky-300"
          >
            <UIcon name="i-lucide-loader-circle" class="h-3.5 w-3.5 shrink-0 animate-spin" />
            <span>{{ t('pipeline.progress.spinningUpContainer') }}</span>
          </div>

          <!-- container is up: show WHAT it's doing (preparing the checkout vs the agent
               making calls) so the step isn't a blank "working" before subtasks appear. -->
          <div
            v-else-if="stepPhaseLabel(s) && !runFailed"
            class="mt-2 flex items-center gap-1.5 text-[11px] text-emerald-300"
          >
            <UIcon name="i-lucide-box" class="h-3.5 w-3.5 shrink-0" />
            <span>{{ stepPhaseLabel(s) }}</span>
          </div>

          <!-- live subtask counts from the agent's todo list -->
          <div v-if="s.subtasks && s.subtasks.total > 0" class="mt-2">
            <div class="flex items-center justify-between text-[10px] text-slate-400">
              <span>
                {{
                  t('pipeline.progress.subtasks', {
                    completed: s.subtasks.completed,
                    total: s.subtasks.total,
                  })
                }}
                <span v-if="s.subtasks.inProgress > 0" class="text-indigo-300">
                  {{ t('pipeline.progress.subtasksInProgress', { count: s.subtasks.inProgress }) }}
                </span>
              </span>
            </div>
            <div class="mt-1 h-1 overflow-hidden rounded-full bg-slate-700/60">
              <div
                class="h-full rounded-full bg-indigo-400 transition-all duration-500"
                :style="{ width: `${(s.subtasks.completed / s.subtasks.total) * 100}%` }"
              />
            </div>

            <!-- the actual todo breakdown, rendered the same way the bootstrap
                 card shows its subtasks (status icon + struck-through when done) -->
            <ul v-if="s.subtasks.items?.length" class="mt-2 space-y-1">
              <li
                v-for="(item, i) in s.subtasks.items"
                :key="i"
                class="flex items-start gap-1.5 text-[11px]"
                :class="
                  item.status === 'completed'
                    ? 'text-slate-500 line-through'
                    : item.status === 'in_progress'
                      ? 'text-slate-100'
                      : 'text-slate-400'
                "
              >
                <UIcon
                  :name="ITEM_ICON[item.status]"
                  class="mt-px h-3 w-3 shrink-0"
                  :class="subtaskIconClass(item.status, runFailed)"
                />
                <span>{{ item.label }}</span>
              </li>
            </ul>
          </div>

          <!-- model used for this step -->
          <p
            v-if="s.model"
            class="mt-2 flex items-center gap-1 truncate text-[10px] text-slate-500"
            :title="s.model"
          >
            <UIcon name="i-lucide-cpu" class="h-3 w-3 shrink-0" />
            {{ models.labelForRef(s.model) }}
          </p>

          <!-- LLM observability rollup (tokens, output-limit headroom, transport-
               vs-execution); click opens the full per-call activity panel. -->
          <StepMetricsBar
            v-if="s.metrics && s.metrics.calls > 0"
            :metrics="s.metrics"
            clickable
            class="mt-2"
            @inspect="ui.openObservability(instance.id)"
          />

          <!-- A one-line hint that the agent produced prose; the full output (and
               all step metadata) lives in the step-detail overlay opened by click. -->
          <p v-if="s.output" class="mt-2 flex items-center gap-1 text-[11px] text-slate-500">
            <UIcon name="i-lucide-book-open-text" class="h-3 w-3 shrink-0" />
            {{ t('pipeline.progress.clickToRead') }}
          </p>

          <!-- Conditionally-run companion (today the Tester's fixer): a distinct
               sub-node marked possible / running / completed / skipped. -->
          <div
            v-if="companionByStep[i]"
            class="mt-3 flex items-center gap-2 rounded-lg border border-dashed border-slate-700/70 bg-slate-900/40 px-2.5 py-1.5"
          >
            <span
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border"
              :class="COMPANION_STATE_META[companionByStep[i]!.state].dot"
            >
              <UIcon
                :name="agentKindMeta(companionByStep[i]!.kind).icon"
                class="h-3 w-3"
                :class="[
                  COMPANION_STATE_META[companionByStep[i]!.state].text,
                  companionByStep[i]!.state === 'running' && !runFailed ? 'animate-spin' : '',
                ]"
              />
            </span>
            <span class="min-w-0 flex-1 truncate text-[12px] text-slate-300">
              {{ agentKindMeta(companionByStep[i]!.kind).label }}
              <span class="text-slate-500">{{ t('pipeline.progress.companionSuffix') }}</span>
            </span>
            <span
              class="shrink-0 text-[11px] font-medium"
              :class="COMPANION_STATE_META[companionByStep[i]!.state].text"
            >
              {{ COMPANION_STATE_META[companionByStep[i]!.state].label }}
            </span>
          </div>

          <!-- Follow-up companion (future-looking Coder): a blinking chip that lights up the
               moment the Coder streams an item; click to triage. Blinks while any item is
               undecided (the gate holds the pipeline until they're all decided). -->
          <button
            v-if="s.followUps?.enabled"
            type="button"
            class="mt-3 flex w-full items-center gap-2 rounded-lg border border-dashed px-2.5 py-1.5 text-start transition hover:border-pink-400/60"
            :class="
              followUpPending(s) > 0
                ? 'border-pink-500/50 bg-pink-500/10 followup-blink'
                : 'border-slate-700/70 bg-slate-900/40'
            "
            @click="ui.openFollowUps(instance.id, i)"
          >
            <span
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-pink-500/40 bg-pink-500/15"
            >
              <UIcon :name="FOLLOW_UP_COMPANION_META.icon" class="h-3 w-3 text-pink-300" />
            </span>
            <span class="min-w-0 flex-1 truncate text-[12px] text-slate-300">
              {{ FOLLOW_UP_COMPANION_META.label }}
              <span class="text-slate-500">{{ t('pipeline.progress.companionSuffix') }}</span>
            </span>
            <span
              class="shrink-0 text-[11px] font-medium"
              :class="followUpPending(s) > 0 ? 'text-pink-300' : 'text-slate-400'"
            >
              {{ followUpLabel(s) }}
            </span>
          </button>

          <!-- Implementation-fork decision phase (Coder step): a spinner while the proposer
               surfaces approaches, then a clickable chip to choose one. -->
          <button
            v-if="forkPhase(s)"
            type="button"
            data-testid="fork-decision-open"
            :data-fork-phase="forkPhase(s)"
            class="mt-3 flex w-full items-center gap-2 rounded-lg border border-dashed px-2.5 py-1.5 text-start transition hover:border-violet-400/60"
            :class="
              forkPhase(s) === 'awaiting_choice'
                ? 'border-violet-500/50 bg-violet-500/10 followup-blink'
                : 'border-slate-700/70 bg-slate-900/40'
            "
            :disabled="forkPhase(s) === 'proposing'"
            @click="ui.openForkDecision(instance.id, i)"
          >
            <span
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-violet-500/40 bg-violet-500/15"
            >
              <UIcon
                :name="
                  forkPhase(s) === 'proposing' ? 'i-lucide-loader-circle' : FORK_DECISION_META.icon
                "
                class="h-3 w-3 text-violet-300"
                :class="forkPhase(s) === 'proposing' ? 'animate-spin' : ''"
              />
            </span>
            <span class="min-w-0 flex-1 truncate text-[12px] text-slate-300">
              {{
                forkPhase(s) === 'proposing'
                  ? t('pipeline.progress.forkDecision.proposing')
                  : t('pipeline.progress.forkDecision.choose')
              }}
            </span>
          </button>

          <!-- reviewer gate folding/re-reviewing in the background: a working indicator,
               NOT a "Review & approve" gate (the human is summoned only if needed) -->
          <div
            v-if="reviewStageLabel(s.agentKind)"
            class="mt-3 inline-flex items-center gap-1 text-[11px] text-indigo-300"
          >
            <UIcon name="i-lucide-loader-circle" class="h-3 w-3 animate-spin" />
            {{ reviewStageLabel(s.agentKind) }}
          </div>

          <!-- approval gate: review (and edit) the proposal before continuing -->
          <div v-else-if="s.approval && s.approval.status === 'pending'" class="mt-3">
            <UButton
              color="warning"
              variant="soft"
              size="xs"
              icon="i-lucide-shield-check"
              @click="emit('openApproval', s.approval.id)"
            >
              {{
                t('pipeline.progress.reviewApprove', { agent: agentKindMeta(s.agentKind).label })
              }}
            </UButton>
          </div>

          <!-- decision: unresolved => prompt, resolved => show the choice -->
          <div v-else-if="s.decision && !s.decision.chosen" class="mt-3">
            <UButton
              color="warning"
              variant="soft"
              size="xs"
              icon="i-lucide-circle-help"
              @click="emit('openDecision', s.decision.id)"
            >
              {{ t('pipeline.progress.resolve', { question: s.decision.question }) }}
            </UButton>
          </div>
          <p
            v-else-if="s.decision?.chosen"
            class="mt-2 flex items-center gap-1 truncate text-[11px] text-emerald-400"
            :title="s.decision.chosen"
          >
            <UIcon name="i-lucide-check" class="h-3 w-3 shrink-0" />
            {{ s.decision.chosen }}
          </p>
        </div>
      </li>
    </ol>
  </div>
</template>

<style scoped>
/* Soft indigo halo around the rail node of the actively-working step. */
@keyframes step-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.5);
  }
  50% {
    box-shadow: 0 0 0 6px rgba(99, 102, 241, 0);
  }
}
.step-active {
  animation: step-pulse 1.6s ease-in-out infinite;
}
/* The Follow-up companion chip blinks (pink) while it has undecided items, drawing the eye
   to forward-looking work surfaced mid-run. */
@keyframes followup-blink {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(244, 114, 182, 0.5);
  }
  50% {
    box-shadow: 0 0 0 5px rgba(244, 114, 182, 0);
  }
}
.followup-blink {
  animation: followup-blink 1.4s ease-in-out infinite;
}
/* These decorative attention halos carry no information the static state lacks, so
   silence them under prefers-reduced-motion (matches the board-pulse rule in main.css). */
@media (prefers-reduced-motion: reduce) {
  .step-active,
  .followup-blink {
    animation: none;
  }
}
</style>
