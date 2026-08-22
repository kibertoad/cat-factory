<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { onKeyStroke } from '@vueuse/core'
import type { IterationCapChoice } from '~/types/execution'
import { agentKindMeta } from '~/utils/catalog'
import StepRestartControl from '~/components/panels/StepRestartControl.vue'
import StepMetadataCard from '~/components/panels/StepMetadataCard.vue'
import StepTestReport from '~/components/panels/StepTestReport.vue'
import StepEffortReport from '~/components/panels/StepEffortReport.vue'
import StepToolServers from '~/components/panels/StepToolServers.vue'
import StepReproductionReport from '~/components/panels/StepReproductionReport.vue'
import StepFragmentAdherence from '~/components/panels/StepFragmentAdherence.vue'
import BinaryOutputReport from '~/components/binaryOutput/BinaryOutputReport.vue'
import EnvironmentStatusPanel from '~/components/environments/EnvironmentStatusPanel.vue'
import FrontendBindingsResolved from '~/components/panels/inspector/FrontendBindingsResolved.vue'
import { UI_TESTER_AGENT_KIND, blockingReviewComments } from '@cat-factory/contracts'
import type { GateApprovalRefusal } from '@cat-factory/contracts'
import ProvisioningLogsDrawer from '~/components/provisioning/ProvisioningLogsDrawer.vue'
import IterationCapPrompt from '~/components/pipeline/IterationCapPrompt.vue'
import StepExecutionHistory from '~/components/board/StepExecutionHistory.vue'
import { useStepTimer } from '~/composables/useStepTimer'
import { useStepProse } from '~/composables/useStepProse'
import { useStepApproval } from '~/composables/useStepApproval'
import {
  REDIRECT_PARK_PRESENTATION,
  type RedirectParkView,
  dedicatedParkView,
  runIsActive,
} from '~/utils/pipelineRender'
import InputGateNotice from '~/components/inputGate/InputGateNotice.vue'
import RunDetailLoadState from '~/components/panels/RunDetailLoadState.vue'

// Detail overlay for a single pipeline step. Opened by clicking an agent in the
// inspector list (TaskExecution) or the focus-view pipeline (PipelineProgress) via
// `ui.openStepDetail(instanceId, stepIndex)`. It resolves the step from the
// execution store so it stays live while open, and shows the step's metadata
// (state, timing, model, subtasks, fragments, decision/approval). When the agent
// produced prose (architect, researcher, reviewer, …) it also renders that output
// as markdown, split into collapsible sections with an auto-generated ToC sidebar.
// This component is orchestration only: the metadata card + the tester report are
// child components, and the live clock / prose reader / approval-review state machine
// live in the `useStepTimer` / `useStepProse` / `useStepApproval` composables.
const ui = useUiStore()
const execution = useExecutionStore()
const board = useBoardStore()
const models = useModelsStore()
const workspace = useWorkspaceStore()
const { t } = useI18n()

onMounted(() => models.ensureLoaded(workspace.workspaceId ?? undefined))

const ctx = computed(() => ui.stepDetail)
const instance = computed(() => execution.getInstance(ctx.value?.instanceId))
const step = computed(() =>
  ctx.value ? (instance.value?.steps[ctx.value.stepIndex] ?? null) : null,
)
/**
 * The run this overlay is about, and the fetch that makes it WHOLE. The board snapshot carries a
 * lean projection (`projectExecutionForBoard`) whose steps withhold the very prose this reader
 * renders, so opening a step asks for the run behind it. A run the store already holds whole (one
 * a live `execution` event delivered, or one already fetched) costs nothing.
 */
watch(
  () => ctx.value?.instanceId ?? null,
  (id) => void execution.ensureFull(id),
  {
    immediate: true,
  },
)
const block = computed(() => (instance.value ? board.getBlock(instance.value.blockId) : undefined))
const agent = computed(() => (step.value ? agentKindMeta(step.value.agentKind) : null))
const open = computed(() => !!ctx.value && !!step.value)

const stepNumber = computed(() => (ctx.value ? ctx.value.stepIndex + 1 : 0))
const totalSteps = computed(() => instance.value?.steps.length ?? 0)

// Companion verdicts for a companion step: the full sequence of correction cycles.
const companionVerdicts = computed(() => step.value?.companion?.verdicts ?? [])
const latestVerdict = computed(() => companionVerdicts.value.at(-1) ?? null)
const pctOf = (n: number) => `${Math.round(n * 100)}%`

// A tester step's latest structured report (what was tested, outcomes, concerns,
// greenlight) + its loop phase/attempts, surfaced when this is a `tester` step.
const testReport = computed(() => step.value?.test?.lastReport ?? null)
const testPhase = computed(() => step.value?.test ?? null)

// The ephemeral environment this step runs against (deployer provisions it; tester/
// coder consume it), so the panel shows its spinning-up/running/shutdown/errored state.
const stepEnvironment = computed(() => step.value?.environment ?? null)

// For a frontend UI-test step (`tester-ui`): the enclosing `frontend` frame's backend-binding
// config, so the detail can project how each env var resolved (live URL | mocked) — rendered from
// the FROZEN bindings the engine stamped on the run (`instance.frontendBindings`), so a finished
// run shows what it actually drove against rather than re-resolving against current live state.
const frontendFrame = computed(() => (block.value ? board.serviceOf(block.value) : undefined))
const isFrontendFrame = computed(() => frontendFrame.value?.type === 'frontend')
const frontendConfig = computed(() =>
  step.value?.agentKind === UI_TESTER_AGENT_KIND && isFrontendFrame.value
    ? (frontendFrame.value!.frontendConfig ?? null)
    : null,
)
// The frozen start-time resolution the tester ran against (absent for a non-frontend / pre-6b run).
const frontendBindings = computed(() => instance.value?.frontendBindings ?? [])
// The run-start advisories the engine stamped on the run (duplicate env vars / partially-mocked
// services) are a whole-RUN fact, so surface them on ANY step detail of a frontend-frame run, not
// only the `tester-ui` step — a duplicate-env-var note shouldn't be invisible from the coder step.
const runNotes = computed(() => (isFrontendFrame.value ? (instance.value?.notes ?? []) : []))

// The run's infrastructure attempts (container/runner/env spin-up + tear-down), behind
// a toggle. This is the surface that makes the per-run `container` log rows + the
// executionId filter visible — most useful when the run failed to start a container.
const showProvisioning = ref(false)
const executionId = computed(() => instance.value?.id ?? null)

// This step's own "execution history": the run-level failure trail narrowed to the failures
// recorded for THIS step (each carries the `stepIndex` it failed at). Includes the current
// failure when the run is presently failed at this step (it moves into `failureHistory` only on
// the next retry). Revealed behind a toggle, mirroring the infra-attempts drawer above.
const stepFailures = computed(() => {
  const idx = ctx.value?.stepIndex
  if (idx == null) return []
  const trail = [...(instance.value?.failureHistory ?? [])]
  if (instance.value?.failure) trail.push(instance.value.failure)
  return trail.filter((f) => f.stepIndex === idx)
})
// The positive complement of the failure trail: the SUCCESSFUL outputs a restart discarded
// for THIS step (each carries the `stepIndex` that produced it), so the history surfaces what
// superseded attempts produced — not only errors. Merged with `stepFailures` in the timeline.
const stepOutputs = computed(() => {
  const idx = ctx.value?.stepIndex
  if (idx == null) return []
  return (instance.value?.outputHistory ?? []).filter((o) => o.stepIndex === idx)
})
// Whether this step has ANY prior-attempt history (successful outputs and/or failures).
const hasStepHistory = computed(() => stepFailures.value.length > 0 || stepOutputs.value.length > 0)
const showHistory = ref(false)

// A failed run is no longer executing: a step left mid-flight (state still
// `working`, no `finishedAt`) must stop looking live — no ticking clock, no
// "spinning up" phase, no spinner.
const runFailed = computed(() => instance.value?.status === 'failed')

// Whether the engine is still driving this run, and so can still spin infrastructure up or down.
// One shared predicate drives every infra surface below: the attempts drawer's background poll
// (manual refresh stays available regardless), the container card's cold-boot spinner, and the
// environment panel's transition spinner. A run that is terminal OR parked has nothing in flight,
// so none of those may keep animating.
const runActive = computed(() => runIsActive(instance.value?.status))

// Live elapsed-time clock for the open step.
const { isRunning, durationLabel } = useStepTimer({
  step: () => step.value,
  runFailed: () => runFailed.value,
  failureAt: () => instance.value?.failure?.occurredAt,
})

// The prose reader: heading outline, collapse state, scroll-spy + scroll refs.
const prose = useStepProse(() => step.value?.output ?? '')
const {
  outline,
  tocSections,
  hasOutput,
  collapsed,
  activeId,
  scrollEl,
  sectionEls,
  toggle,
  setAll,
  allCollapsed,
  goTo,
  onScroll,
} = prose

const approvalPending = computed(() => step.value?.approval?.status === 'pending')
const approvalId = computed(() => step.value?.approval?.id ?? null)
// Whether "approve with corrections" applies. A step whose output is a deterministic
// RENDERING of an artifact it already produced (the initiative plan, the spec doc, the
// blueprint tree — `step.outputIsRendered`, set by the engine's `reviewableArtifactOutput`
// seam) has no editable proposal: the artifact was ingested into domain state before the gate
// was raised, so an edit typed over the rendering would never reach it. The backend refuses
// such an edit; hiding the affordance is what stops a reviewer typing corrections into a
// dead end. Their route is "request changes", which re-runs the producer with the correction.
const proposalEditable = computed(() => step.value?.outputIsRendered !== true)
// A companion step parked at its automatic-rework cap: instead of the generic
// approve/request-changes/reject rail, it shows the shared iteration-cap prompt
// (one more round / proceed / stop & reset), resolved through its own endpoint.
const companionExceeded = computed(() => approvalPending.value && !!step.value?.companion?.exceeded)
/**
 * The must-fix findings the reviewer left open on its last round.
 *
 * They are why the cap prompts read differently, and the difference is not cosmetic: a cap
 * reached on the rating alone is the loop reporting that this is as good as it got, while an open
 * blocker is the reviewer saying the work must not go on as it stands. That second one is also the
 * park no risk policy will answer, so the person reading it is the only route past it and should
 * be told what they are being asked to overrule.
 */
const blockingFindings = computed(() => blockingReviewComments(latestVerdict.value?.comments))
// The SAME park, reached for the opposite reason: the loop was abandoned with rounds still on the
// budget because the producer handed back the work it was asked to change and the rating did not
// move. The three choices are identical, so this only picks the wording — the cap copy states a
// spent limit, which is a false claim about this park (`companion.stalled`).
//
// It can hold TOGETHER with `blockingFindings`, and that pair is what splits the wording across
// the two slots rather than ranking them: the HEADING says how the loop ended (a stalled one did
// not reach its limit, so only it may say so) and the DETAIL says what this person is being asked
// to decide (an open blocker outranks a bar that went unmet, and its copy claims nothing about
// rounds). Neither slot can then state something untrue of the park it is describing.
//
// Which is why the stalled heading claims nothing about the RATING either. Standing still is
// unchanged output at an unmoved rating (`companionLoopStalled`), never a rating under the bar: a
// round held by an open blocker fails at a rating that cleared it, and the copy said "the rating
// held below the 80% bar" over a 95% one. What the number was is on the verdict card above.
const companionStalled = computed(() => companionExceeded.value && !!step.value?.companion?.stalled)
// A park a DEDICATED window owns (fork choice / follow-up triage): the generic approve
// resolver refuses these server-side, so the rail is replaced by a redirect to that window.
// Computed live, since a coder step can park on one WHILE this overlay is already open
// (the routing in `dispatchStepView` only covers the open click).
const dedicatedPark = computed(() =>
  step.value ? dedicatedParkView(step.value, instance.value) : null,
)
/**
 * The PRE-DISPATCH INPUT GATE's verdict when it is what holds this step. Answered INLINE here
 * (unlike the other dedicated parks, which redirect to a window): its remedy is to edit the
 * task, so there is no second modal to send anyone to.
 *
 * Only the PARK, hence the literal `blocked` tone at the call site: this overlay exists to
 * answer one step's park, and an advisory finding is about the run rather than this step. It is
 * reported once, on the run panel, instead of on every step overlay opened under it.
 */
const inputGateVerdict = computed(() =>
  dedicatedPark.value === 'input-gate' ? (instance.value?.inputGate ?? null) : null,
)
/** The generic approve/request-changes/reject rail applies (no dedicated surface owns the park). */
const genericApprovalPending = computed(
  () => approvalPending.value && !companionExceeded.value && !dedicatedPark.value,
)

/**
 * How the park that holds this step presents itself (prose, icon, action label), or null when no
 * window owns it. Read from the shared table rather than branched on here, so this overlay cannot
 * go on naming the fork decision for a park that is not one.
 */
const parkPresentation = computed(() =>
  dedicatedPark.value && dedicatedPark.value !== 'input-gate'
    ? REDIRECT_PARK_PRESENTATION[dedicatedPark.value]
    : null,
)

/**
 * Jump from this overlay to the window that can actually resolve the dedicated park.
 *
 * A `Record` over the vocabulary rather than an `if` chain, for the reason the presentation table
 * gives: an unhandled member falls out of a chain as a button that closes this overlay and opens
 * NOTHING, which is indistinguishable from a misclick. Here a new park fails to compile until it
 * names its opener.
 */
const PARK_OPENERS: Record<RedirectParkView, (instanceId: string, stepIndex: number) => void> = {
  'follow-ups': (id, idx) => ui.openFollowUps(id, idx),
  'fork-decision': (id, idx) => ui.openForkDecision(id, idx),
  'binary-candidates': (id, idx) => ui.openBinaryCandidates(id, idx),
}

function openDedicatedWindow() {
  const c = ctx.value
  const park = dedicatedPark.value
  if (!c || !park || park === 'input-gate') return
  close()
  PARK_OPENERS[park](c.instanceId, c.stepIndex)
}

// The GitHub-style approval/review state machine for a pending gate step. A park a
// dedicated window owns is NOT reviewable here, so it doesn't count as pending.
// (`close` is passed by hoisted function reference; it's declared below `approval`,
// which it resets.)
const approval = useStepApproval({
  step: () => step.value,
  scrollEl: () => scrollEl.value,
  instanceId: () => ctx.value?.instanceId,
  approvalId: () => approvalId.value,
  approvalPending: () => approvalPending.value && !dedicatedPark.value,
  companionExceeded: () => companionExceeded.value,
  close,
})
const {
  reviewComments,
  feedback,
  submitting,
  draftTarget,
  draftBody,
  editing,
  draftProposal,
  rejectArmed,
  canRequestChanges,
  quorum: gateQuorum,
  viewerHasApproved,
  approvalWouldClearGate,
  refusal: gateRefusal,
  onProseClick,
  addDraftComment,
  cancelDraft,
  removeComment,
  approve,
  startEditing,
  cancelEditing,
  approveWithEdits,
  requestChanges,
  armReject,
  disarmReject,
  reject,
} = approval

function close() {
  // Reset the approval-mode sub-states so reopening the same step is clean
  // (the step-change watch only fires when the step key actually changes).
  approval.resetForClose()
  ui.closeStepDetail()
}

/**
 * Why the gate refuses this viewer, worded for them. An exhaustive Record over the shared refusal
 * vocabulary with LITERAL keys, so the typed-message-key check sees them and a new refusal reason
 * fails the typecheck instead of rendering as a blank line under a disabled button.
 */
const GATE_REFUSAL_KEYS: Record<GateApprovalRefusal, string> = {
  not_a_gate_approver: 'panels.stepDetail.notAnApprover',
  gate_approver_identity_required: 'panels.stepDetail.approverIdentityRequired',
}

/**
 * Whether "approve with corrections" is offered RIGHT NOW. Two independent reasons withhold it,
 * and they are kept apart because their remedies differ: an output that is a rendering can never
 * be edited here, while an unmet quorum only means not yet: this viewer's approval is not the
 * one that clears the gate, and an edit under it would move the artifact beneath the approvals
 * already recorded. Each states itself below rather than the button quietly vanishing.
 */
const proposalEditableNow = computed(() => proposalEditable.value && approvalWouldClearGate.value)

const resolvingCap = ref(false)
async function resolveCompanionCap(choice: IterationCapChoice) {
  if (!ctx.value || !approvalId.value || resolvingCap.value) return
  resolvingCap.value = true
  try {
    await execution.resolveCompanionExceeded(ctx.value.instanceId, approvalId.value, choice)
    close()
  } finally {
    resolvingCap.value = false
  }
}

// Re-seed the reader (all sections expanded, scrolled to top) + reset the review
// drafts whenever a different step opens.
watch(
  () => ctx.value && `${ctx.value.instanceId}:${ctx.value.stepIndex}`,
  () => {
    prose.reset()
    approval.resetForStep()
    // Collapse the per-step execution history so reopening a different step starts clean.
    showHistory.value = false
  },
)

onKeyStroke('Escape', () => {
  if (open.value) close()
})

const { copy } = useCopyToClipboard()
async function copyOutput() {
  if (step.value?.output) await copy(step.value.output)
}
</script>

<template>
  <!-- The Teleport and the reader-fade Transition are owned by the parent mount
       (pages/index.vue), so the fade plays in BOTH directions across the v-if that mounts and
       unmounts this chunk. An inner Transition cannot: it never animates its own first render
       (a Transition without `appear` treats a mount as no transition at all), and it is torn
       down before it could run a leave. Same split, and the same reason, as BlockFocusView. -->
  <!-- `data-agent-kind` names WHICH step this window is scoped to, as the kind rather than as
       the heading beside it: the heading is a translated display label, so it is the wrong
       thing to read for anything that needs to know which agent's step is open. -->
  <div
    v-if="open && step && agent"
    data-testid="step-detail"
    :data-agent-kind="step?.agentKind"
    class="fixed inset-0 z-50 flex max-h-[100dvh] bg-slate-950/96 backdrop-blur-sm"
    role="dialog"
    aria-modal="true"
  >
    <!-- ToC sidebar (only meaningful when there are prose headings) -->
    <aside
      v-if="outline.hasToc"
      data-testid="step-detail-toc"
      class="hidden w-72 shrink-0 flex-col border-e border-slate-800 bg-slate-900/60 md:flex"
    >
      <div class="border-b border-slate-800 px-4 py-3">
        <div class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {{ t('panels.stepDetail.contents') }}
        </div>
      </div>
      <nav class="flex-1 space-y-0.5 overflow-auto px-2 py-3">
        <button
          class="block w-full truncate rounded-md px-2 py-1 text-start text-[13px] transition"
          :class="
            activeId === 'step-details'
              ? 'bg-indigo-500/15 font-medium text-indigo-200'
              : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
          "
          @click="goTo('step-details')"
        >
          {{ t('panels.stepDetail.details') }}
        </button>
        <button
          v-for="s in tocSections"
          :key="s.id"
          class="block w-full truncate rounded-md px-2 py-1 text-start text-[13px] transition"
          :class="
            activeId === s.id
              ? 'bg-indigo-500/15 font-medium text-indigo-200'
              : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
          "
          :style="{ paddingLeft: `${(s.depth - outline.minDepth) * 0.85 + 0.5}rem` }"
          :title="s.title"
          @click="goTo(s.id)"
        >
          {{ s.title }}
        </button>
      </nav>
    </aside>

    <!-- main column -->
    <div class="flex min-w-0 flex-1 flex-col">
      <header class="flex items-center gap-3 border-b border-slate-800 px-6 py-4">
        <div
          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
          :style="{ backgroundColor: agent.color + '22' }"
        >
          <UIcon :name="agent.icon" class="h-5 w-5" :style="{ color: agent.color }" />
        </div>
        <div class="min-w-0">
          <h1 class="truncate text-base font-semibold text-white">{{ agent.label }}</h1>
          <p v-if="block" class="truncate text-xs text-slate-500">{{ block.title }}</p>
        </div>
        <div class="ms-auto flex items-center gap-1.5">
          <UBadge
            v-if="genericApprovalPending"
            color="warning"
            variant="subtle"
            size="sm"
            class="me-1"
          >
            <UIcon name="i-lucide-shield-check" class="me-1 h-3 w-3" />
            {{ t('panels.stepDetail.approvalRequired') }}
          </UBadge>
          <UBadge
            v-else-if="companionExceeded || dedicatedPark"
            color="warning"
            variant="subtle"
            size="sm"
            class="me-1"
          >
            <UIcon name="i-lucide-alert-triangle" class="me-1 h-3 w-3" />
            {{ t('panels.stepDetail.decisionRequired') }}
          </UBadge>
          <UButton
            v-if="outline.sections.length"
            :icon="allCollapsed ? 'i-lucide-unfold-vertical' : 'i-lucide-fold-vertical'"
            color="neutral"
            variant="ghost"
            size="sm"
            :title="
              allCollapsed ? t('panels.stepDetail.expandAll') : t('panels.stepDetail.collapseAll')
            "
            @click="setAll(!allCollapsed)"
          />
          <UButton
            v-if="hasOutput"
            icon="i-lucide-copy"
            color="neutral"
            variant="ghost"
            size="sm"
            :title="t('panels.stepDetail.copyRawOutput')"
            @click="copyOutput"
          />
          <!-- Restart the pipeline from this step (shared two-click confirm; resetting
               later steps is destructive). Keyed on the step so its armed state resets
               when a different step opens within this overlay. -->
          <StepRestartControl
            :key="`${ctx?.instanceId}:${ctx?.stepIndex}`"
            :instance-id="ctx?.instanceId ?? null"
            :step-index="ctx?.stepIndex ?? null"
            @restarted="close"
          />
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            size="sm"
            :title="t('panels.stepDetail.closeEsc')"
            @click="close"
          />
        </div>
      </header>

      <!-- Whether the whole-run fetch behind this reader's prose has landed. -->
      <RunDetailLoadState :instance-id="ctx?.instanceId ?? null" />

      <div ref="scrollEl" class="flex-1 overflow-auto px-6 py-6" @scroll="onScroll">
        <div class="mx-auto max-w-3xl space-y-5">
          <!-- metadata card (always shown) -->
          <section
            id="step-details"
            :ref="(el) => (sectionEls['step-details'] = el as HTMLElement | null)"
            class="scroll-mt-4 rounded-xl border border-slate-800 bg-slate-900/50 p-4"
          >
            <StepMetadataCard
              :step="step"
              :run-failed="runFailed"
              :run-active="runActive"
              :duration-label="durationLabel"
              :is-running="isRunning"
              :step-number="stepNumber"
              :total-steps="totalSteps"
              :instance-id="instance?.id"
              :companion-verdicts="companionVerdicts"
              :latest-verdict="latestVerdict"
            />
          </section>

          <!-- post-run Kaizen grading status + results for this step (run-details only) -->
          <KaizenStepStatus
            :instance-id="ctx?.instanceId ?? null"
            :step-index="ctx?.stepIndex ?? null"
          />

          <!-- companion rework budget spent, OR the loop abandoned early as unproductive,
               with or without must-fix findings still open: the shared iteration-cap decision
               (one more round / proceed with the current output / stop & reset). One prompt,
               and the two slots are picked on different facts — the choices are the same but
               the reason is not, the spent-limit wording is untrue of a stalled loop, and an
               open blocker is what the person is actually being asked to overrule. -->
          <IterationCapPrompt
            v-if="companionExceeded"
            :heading="
              companionStalled
                ? t('panels.stepDetail.companionStalledHeading', {
                    agent: agent.label,
                    attempts: step.companion?.attempts,
                    maxAttempts: step.companion?.maxAttempts,
                  })
                : blockingFindings.length
                  ? t(
                      'panels.stepDetail.companionCapBlockedHeading',
                      {
                        agent: agent.label,
                        attempts: step.companion?.maxAttempts,
                        count: blockingFindings.length,
                      },
                      blockingFindings.length,
                    )
                  : t('panels.stepDetail.companionCapHeading', {
                      agent: agent.label,
                      attempts: step.companion?.maxAttempts,
                      threshold: pctOf(latestVerdict?.threshold ?? 0),
                    })
            "
            :detail="
              blockingFindings.length
                ? t('panels.stepDetail.companionCapBlockedDetail')
                : companionStalled
                  ? t('panels.stepDetail.companionStalledDetail')
                  : t('panels.stepDetail.companionCapDetail')
            "
            :loading="resolvingCap"
            @resolve="resolveCompanionCap"
          />

          <!-- a park a dedicated window owns (fork choice / follow-up triage / candidate
               comparison): the generic approval rail can't resolve it (the server refuses),
               so point the human at the window that can. Copy and icon come from the shared
               per-park table, so a park added to the vocabulary can never inherit another
               one's wording here. -->
          <!-- the pre-dispatch input gate holds this step: answered here, in place -->
          <InputGateNotice
            v-if="inputGateVerdict && instance"
            :gate="inputGateVerdict"
            tone="blocked"
            :execution-id="instance.id"
            compact
          />

          <div
            v-if="parkPresentation"
            class="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4"
            data-testid="dedicated-park-redirect"
            :data-park="dedicatedPark"
          >
            <p class="text-[13px] leading-relaxed text-amber-200/90">
              {{ t(parkPresentation.noticeKey) }}
            </p>
            <UButton
              class="mt-3"
              color="primary"
              size="sm"
              :icon="parkPresentation.icon"
              data-testid="dedicated-park-open"
              @click="openDedicatedWindow"
            >
              {{ t(parkPresentation.actionKey) }}
            </UButton>
          </div>

          <!-- ephemeral environment lifecycle (spinning up / running / shut down /
               errored + the exact error), when this step runs against one -->
          <EnvironmentStatusPanel
            v-if="stepEnvironment"
            :environment="stepEnvironment"
            :run-active="runActive"
          />

          <!-- frontend UI-test: how the frame's backend bindings resolved (env var →
               live URL | mocked) + the run-start advisories (duplicate env vars /
               partially-mocked services) the engine stamped on the run. Rendered from the
               FROZEN start-time bindings so a finished run shows what it actually drove
               against, not a live re-resolution. -->
          <FrontendBindingsResolved
            v-if="frontendConfig"
            :config="frontendConfig"
            :resolved="frontendBindings"
          />
          <ul v-if="runNotes.length" class="space-y-1" data-testid="run-notes">
            <li
              v-for="(note, i) in runNotes"
              :key="i"
              class="flex items-start gap-1.5 text-[11px] leading-snug text-amber-300/80"
            >
              <UIcon name="i-lucide-info" class="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{{ note }}</span>
            </li>
          </ul>

          <!-- this run's infrastructure attempts (container/runner/env spin-up +
               tear-down): the surface for the per-run container log rows + the exact
               provider error, behind a toggle (most useful on a failed-to-start run) -->
          <div v-if="executionId">
            <UButton
              :icon="showProvisioning ? 'i-lucide-chevron-up' : 'i-lucide-scroll-text'"
              variant="ghost"
              size="xs"
              @click="
                () => {
                  showProvisioning = !showProvisioning
                }
              "
            >
              {{
                showProvisioning
                  ? t('panels.stepDetail.hideInfraAttempts')
                  : t('panels.stepDetail.infraAttempts')
              }}
            </UButton>
            <ProvisioningLogsDrawer
              v-if="showProvisioning"
              class="mt-2"
              :execution-id="executionId"
              :live="runActive"
            />
          </div>

          <!-- this step's execution history (the run-level trail narrowed to this step),
               behind a toggle — a merged timeline of the SUCCESSFUL outputs a restart
               superseded and the FAILED attempts, scoped to the step being looked at -->
          <div v-if="hasStepHistory">
            <UButton
              :icon="showHistory ? 'i-lucide-chevron-up' : 'i-lucide-history'"
              variant="ghost"
              size="xs"
              data-testid="step-execution-history-toggle"
              @click="
                () => {
                  showHistory = !showHistory
                }
              "
            >
              {{
                showHistory
                  ? t('panels.stepDetail.hideExecutionHistory')
                  : t('panels.stepDetail.executionHistory')
              }}
            </UButton>
            <StepExecutionHistory
              v-if="showHistory"
              class="mt-2"
              :failures="stepFailures"
              :outputs="stepOutputs"
              data-testid="step-execution-history"
            />
          </div>

          <!-- tester report: what was tested, the per-area outcomes, the concerns
               it raised and the greenlight verdict; plus the fixer-loop phase -->
          <StepTestReport v-if="testReport" :report="testReport" :phase="testPhase" />

          <!-- code/PR reviewer's best-practice adherence: per standard, a 1..10 rating of how
               well the change adheres + the issues it surfaced. Only on a review step. -->
          <StepFragmentAdherence
            v-if="step.fragmentAdherence?.length"
            :items="step.fragmentAdherence"
          />

          <!-- container agent's effort self-assessment (how hard it was, what reduced its
               effectiveness, key obstacles). Only when the agent reported one. -->
          <StepEffortReport v-if="step.effortReport" :report="step.effortReport" />

          <!-- the tool servers (MCP) this dispatch wired, and the ones it dropped with the
               reason. Only on a container step, and self-hiding when the record holds
               nothing: a recorded pair of empty lists is a kind that declared none, which is
               every step on a deployment that registers no tool servers at all. -->
          <StepToolServers
            v-if="step.toolServers"
            :tool-servers="step.toolServers"
            :step-agent-kind="step.agentKind"
          />

          <!-- the bugfix REPRODUCTION PROOF: the declared reproducing check run against the
               pre-fix tree and the final one, with both captured outputs, or the agent's
               structural declaration that the bug cannot be reproduced. This panel is the
               half that matters most: the engine records the proof on whichever step OPENED
               the pull request, and in every built-in pipeline that is the `coder` — a kind
               with no dedicated result view, so it opens HERE and the result-window shell is
               never involved. Self-hiding for a run that declared no reproducing check. -->
          <StepReproductionReport
            v-if="step.reproduction"
            :report="step.reproduction"
            variant="card"
          />

          <!-- what the step declared it stored through a foundational storage service, and
               every way that record is incomplete. This panel is the OTHER half of the
               result-window shell's trailing section: a step whose kind declares no
               dedicated result view opens here instead, and the shell is not involved — so
               without this the artifacts of exactly the kinds that need no bespoke window
               would have nowhere to appear. Self-hiding when the step has neither a report
               nor a selection, which is every step of every stock pipeline. -->
          <BinaryOutputReport :step="step" variant="card" />

          <!-- edit-then-approve: a direct editor over the raw conclusions; the
               edits become the approved proposal that flows to the next step -->
          <section v-if="editing" class="scroll-mt-4">
            <div class="mb-2 flex items-center gap-1.5 text-[11px] text-amber-400">
              <UIcon name="i-lucide-pencil" class="h-3.5 w-3.5" />
              <span class="font-semibold uppercase tracking-wide">{{
                t('panels.stepDetail.editingConclusions')
              }}</span>
            </div>
            <UTextarea
              v-model="draftProposal"
              :rows="22"
              autoresize
              size="sm"
              class="w-full"
              :ui="{ base: 'font-mono text-[12px] leading-relaxed' }"
              :placeholder="t('panels.stepDetail.editConclusionsPlaceholder')"
            />
          </section>

          <!-- the agent's prose output, sectioned + collapsible -->
          <template v-else-if="hasOutput">
            <section
              v-for="s in outline.sections"
              :id="s.id"
              :key="s.id"
              :ref="(el) => (sectionEls[s.id] = el as HTMLElement | null)"
              class="scroll-mt-4"
            >
              <button
                v-if="s.depth > 0"
                class="group flex w-full items-center gap-2 rounded-md py-1 text-start transition hover:text-white"
                @click="toggle(s.id)"
              >
                <UIcon
                  name="i-lucide-chevron-right"
                  class="h-4 w-4 shrink-0 text-slate-500 transition-transform group-hover:text-slate-300"
                  :class="collapsed[s.id] ? '' : 'rotate-90'"
                />
                <span
                  class="font-semibold text-slate-100"
                  :class="s.depth <= 1 ? 'text-lg' : s.depth === 2 ? 'text-base' : 'text-sm'"
                  v-html="s.titleHtml"
                />
              </button>
              <!-- eslint-disable-next-line vue/no-v-html -->
              <div
                v-show="!collapsed[s.id]"
                class="reader-prose mt-1 text-[13px] leading-relaxed text-slate-300"
                :class="[
                  s.depth > 0 ? 'ps-6' : '',
                  genericApprovalPending && !editing ? 'review-mode' : '',
                ]"
                @click="onProseClick"
                v-html="s.bodyHtml"
              />
            </section>
          </template>

          <p
            v-else
            class="rounded-lg border border-dashed border-slate-800 py-6 text-center text-sm text-slate-500"
          >
            {{ t('panels.stepDetail.noProseOutput') }}
          </p>
        </div>
      </div>
    </div>

    <!-- review rail (approval mode): per-block comments + overall feedback +
         Approve / Request changes / Reject. A end-side rail on wide screens; a
         bottom sheet (still reachable) below lg, so the gate is always actionable. -->
    <aside
      v-if="genericApprovalPending"
      class="absolute inset-x-0 bottom-0 z-10 flex max-h-[70dvh] flex-col rounded-t-2xl border-t border-slate-700 bg-slate-900/95 shadow-2xl backdrop-blur lg:static lg:inset-auto lg:z-auto lg:max-h-none lg:w-96 lg:shrink-0 lg:rounded-none lg:border-s lg:border-t-0 lg:border-slate-800 lg:bg-slate-900/60 lg:shadow-none lg:backdrop-blur-none"
    >
      <div class="border-b border-slate-800 px-4 py-3">
        <div class="text-[11px] font-semibold uppercase tracking-wide text-amber-400">
          {{
            editing
              ? t('panels.stepDetail.approveWithCorrections')
              : t('panels.stepDetail.reviewAndApprove')
          }}
        </div>
        <p class="mt-1 text-[12px] text-slate-400">
          {{ editing ? t('panels.stepDetail.editHint') : t('panels.stepDetail.reviewHint') }}
        </p>
        <!-- The gate's configured POLICY, when it has one. Both lines exist because an
           approve on such a gate legitimately may not advance the run: without the tally, a
           correctly-recorded approval is indistinguishable from a call that failed, and
           without the refusal a person would press a button the server answers 403. -->
        <p v-if="gateQuorum" class="mt-1 text-[12px] text-amber-300/90" data-testid="gate-quorum">
          {{
            t('panels.stepDetail.quorumProgress', {
              recorded: gateQuorum.recorded,
              required: gateQuorum.required,
            })
          }}
          <span v-if="viewerHasApproved">{{ t('panels.stepDetail.quorumYours') }}</span>
        </p>
        <p
          v-if="gateRefusal"
          class="mt-1 text-[12px] text-slate-400"
          data-testid="gate-not-approver"
        >
          {{ t(GATE_REFUSAL_KEYS[gateRefusal]) }}
        </p>
      </div>

      <div class="flex-1 space-y-3 overflow-auto overscroll-contain px-4 py-3">
        <p
          v-if="editing"
          class="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-[12px] leading-relaxed text-amber-200/90"
        >
          {{ t('panels.stepDetail.editingNotice') }}
        </p>
        <template v-else>
          <!-- composer for the block the human just clicked -->
          <div
            v-if="draftTarget"
            data-testid="step-review-composer"
            class="rounded-lg border border-indigo-500/40 bg-indigo-500/5 p-3"
          >
            <div class="mb-1 text-[10px] uppercase tracking-wide text-indigo-300">
              {{ t('panels.stepDetail.commentingOn') }}
            </div>
            <pre
              class="mb-2 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-slate-950/60 p-2 text-[11px] text-slate-300"
              >{{ draftTarget.quotedSource }}</pre>
            <UTextarea
              v-model="draftBody"
              data-testid="step-review-comment-body"
              :rows="3"
              autoresize
              size="sm"
              class="w-full"
              :placeholder="t('panels.stepDetail.commentPlaceholder')"
            />
            <div class="mt-2 flex justify-end gap-2">
              <UButton color="neutral" variant="ghost" size="xs" @click="cancelDraft">
                {{ t('common.cancel') }}
              </UButton>
              <UButton
                color="primary"
                size="xs"
                data-testid="step-review-comment-add"
                :disabled="!draftBody.trim()"
                @click="addDraftComment"
              >
                {{ t('panels.stepDetail.addComment') }}
              </UButton>
            </div>
          </div>

          <!-- comments added so far -->
          <div
            v-for="(c, idx) in reviewComments"
            :key="idx"
            data-testid="step-review-comment"
            class="rounded-lg border border-slate-800 bg-slate-900/50 p-3"
          >
            <div class="mb-1 flex items-start justify-between gap-2">
              <div class="text-[10px] uppercase tracking-wide text-slate-500">
                {{ t('panels.stepDetail.commentN', { number: idx + 1 }) }}
              </div>
              <button
                class="text-slate-500 transition hover:text-rose-400"
                :title="t('panels.stepDetail.removeComment')"
                @click="removeComment(idx)"
              >
                <UIcon name="i-lucide-x" class="h-3.5 w-3.5" />
              </button>
            </div>
            <pre
              class="mb-1 max-h-20 overflow-auto whitespace-pre-wrap rounded bg-slate-950/50 p-1.5 text-[10px] text-slate-400"
              >{{ c.quotedSource }}</pre>
            <p class="text-[12px] text-slate-200">{{ c.body }}</p>
          </div>

          <div>
            <label
              class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400"
            >
              {{ t('panels.stepDetail.overallFeedback') }}
            </label>
            <UTextarea
              v-model="feedback"
              data-testid="step-review-feedback"
              :rows="3"
              autoresize
              size="sm"
              class="w-full"
              :placeholder="t('panels.stepDetail.overallFeedbackPlaceholder')"
            />
          </div>
        </template>
      </div>

      <!-- edit-then-approve actions -->
      <div
        v-if="editing"
        class="space-y-2 border-t border-slate-800 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
      >
        <UButton
          color="primary"
          size="sm"
          icon="i-lucide-check"
          block
          :loading="submitting"
          @click="approveWithEdits"
        >
          {{ t('panels.stepDetail.approveWithEdits') }}
        </UButton>
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          block
          :disabled="submitting"
          @click="cancelEditing"
        >
          {{ t('panels.stepDetail.cancelEdits') }}
        </UButton>
      </div>

      <div
        v-else
        class="space-y-2 border-t border-slate-800 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
      >
        <UButton
          color="primary"
          data-testid="step-approve"
          size="sm"
          icon="i-lucide-check"
          block
          :disabled="rejectArmed || !!gateRefusal"
          :loading="submitting"
          @click="approve"
        >
          {{ t('panels.stepDetail.approveAndProceed') }}
        </UButton>
        <UButton
          v-if="proposalEditableNow"
          color="primary"
          variant="soft"
          size="sm"
          icon="i-lucide-pencil"
          block
          :disabled="rejectArmed || submitting || !!gateRefusal"
          @click="startEditing"
        >
          {{ t('panels.stepDetail.approveWithCorrections') }}
        </UButton>
        <p
          v-else-if="!proposalEditable"
          class="text-[10px] text-slate-500"
          data-testid="step-rendered-output-note"
        >
          {{ t('panels.stepDetail.renderedOutputNote') }}
        </p>
        <!-- Withheld only until the quorum is one approval away, so it says so rather than
           leaving a reviewer to wonder where the affordance went. -->
        <p v-else class="text-[10px] text-slate-500" data-testid="step-quorum-edit-locked">
          {{ t('panels.stepDetail.quorumEditLocked') }}
        </p>

        <!-- destructive: a two-step inline confirm instead of a native dialog -->
        <div v-if="rejectArmed" class="rounded-lg border border-rose-500/40 bg-rose-500/5 p-2.5">
          <p class="mb-2 text-[11px] text-rose-200">
            {{ t('panels.stepDetail.rejectConfirmPrompt') }}
          </p>
          <div class="flex gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              class="flex-1"
              :disabled="submitting"
              @click="disarmReject"
            >
              {{ t('common.cancel') }}
            </UButton>
            <UButton
              color="error"
              size="xs"
              icon="i-lucide-ban"
              class="flex-1"
              :loading="submitting"
              @click="reject"
            >
              {{ t('panels.stepDetail.confirmReject') }}
            </UButton>
          </div>
        </div>
        <div v-else class="flex gap-2">
          <UButton
            color="warning"
            variant="soft"
            size="sm"
            icon="i-lucide-rotate-ccw"
            class="flex-1"
            data-testid="step-request-changes"
            :disabled="!canRequestChanges || !!gateRefusal"
            :loading="submitting"
            @click="requestChanges"
          >
            {{ t('panels.stepDetail.requestChanges') }}
          </UButton>
          <UButton
            color="error"
            variant="soft"
            size="sm"
            icon="i-lucide-ban"
            class="flex-1"
            :disabled="submitting || !!gateRefusal"
            @click="armReject"
          >
            {{ t('panels.stepDetail.reject') }}
          </UButton>
        </div>
        <p class="text-[10px] text-slate-500">
          {{ t('panels.stepDetail.requestChangesHint') }}
        </p>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.reader-fade-enter-active,
.reader-fade-leave-active {
  transition: opacity 0.18s ease;
}
.reader-fade-enter-from,
.reader-fade-leave-to {
  opacity: 0;
}
</style>
