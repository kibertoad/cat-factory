<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { onKeyStroke } from '@vueuse/core'
import type { IterationCapChoice } from '~/types/execution'
import { agentKindMeta } from '~/utils/catalog'
import StepRestartControl from '~/components/panels/StepRestartControl.vue'
import StepMetadataCard from '~/components/panels/StepMetadataCard.vue'
import StepTestReport from '~/components/panels/StepTestReport.vue'
import EnvironmentStatusPanel from '~/components/environments/EnvironmentStatusPanel.vue'
import FrontendBindingsResolved from '~/components/panels/inspector/FrontendBindingsResolved.vue'
import { UI_TESTER_AGENT_KIND } from '@cat-factory/contracts'
import ProvisioningLogsDrawer from '~/components/provisioning/ProvisioningLogsDrawer.vue'
import IterationCapPrompt from '~/components/pipeline/IterationCapPrompt.vue'
import { useStepTimer } from '~/composables/useStepTimer'
import { useStepProse } from '~/composables/useStepProse'
import { useStepApproval } from '~/composables/useStepApproval'

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

// A failed run is no longer executing: a step left mid-flight (state still
// `working`, no `finishedAt`) must stop looking live — no ticking clock, no
// "spinning up" phase, no spinner.
const runFailed = computed(() => instance.value?.status === 'failed')

// Whether the run is still doing something (can still spin infra up/down). A terminal
// run (`done`/`failed`) has nothing left to provision, so the infra-attempts drawer
// stops its background live-polling (manual refresh stays available).
const runLive = computed(() => {
  const status = instance.value?.status
  return status != null && status !== 'done' && status !== 'failed'
})

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
// A companion step parked at its automatic-rework cap: instead of the generic
// approve/request-changes/reject rail, it shows the shared iteration-cap prompt
// (one more round / proceed / stop & reset), resolved through its own endpoint.
const companionExceeded = computed(() => approvalPending.value && !!step.value?.companion?.exceeded)

function close() {
  // Reset the approval-mode sub-states so reopening the same step is clean
  // (the step-change watch only fires when the step key actually changes).
  approval.resetForClose()
  ui.closeStepDetail()
}

// The GitHub-style approval/review state machine for a pending gate step.
const approval = useStepApproval({
  step: () => step.value,
  scrollEl: () => scrollEl.value,
  instanceId: () => ctx.value?.instanceId,
  approvalId: () => approvalId.value,
  approvalPending: () => approvalPending.value,
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
  <Teleport to="body">
    <Transition name="reader-fade">
      <div
        v-if="open && step && agent"
        data-testid="step-detail"
        class="fixed inset-0 z-50 flex max-h-[100dvh] bg-slate-950/96 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
      >
        <!-- ToC sidebar (only meaningful when there are prose headings) -->
        <aside
          v-if="outline.hasToc"
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
                v-if="approvalPending && !companionExceeded"
                color="warning"
                variant="subtle"
                size="sm"
                class="me-1"
              >
                <UIcon name="i-lucide-shield-check" class="me-1 h-3 w-3" />
                {{ t('panels.stepDetail.approvalRequired') }}
              </UBadge>
              <UBadge
                v-else-if="companionExceeded"
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
                  allCollapsed
                    ? t('panels.stepDetail.expandAll')
                    : t('panels.stepDetail.collapseAll')
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

              <!-- companion rework budget spent: the shared iteration-cap decision
                   (one more round / proceed with the current output / stop & reset) -->
              <IterationCapPrompt
                v-if="companionExceeded"
                :heading="
                  t('panels.stepDetail.companionCapHeading', {
                    agent: agent.label,
                    attempts: step.companion?.maxAttempts,
                    threshold: pctOf(latestVerdict?.threshold ?? 0),
                  })
                "
                :detail="t('panels.stepDetail.companionCapDetail')"
                :loading="resolvingCap"
                @resolve="resolveCompanionCap"
              />

              <!-- ephemeral environment lifecycle (spinning up / running / shut down /
                   errored + the exact error), when this step runs against one -->
              <EnvironmentStatusPanel v-if="stepEnvironment" :environment="stepEnvironment" />

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
                  @click="showProvisioning = !showProvisioning"
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
                  :live="runLive"
                />
              </div>

              <!-- tester report: what was tested, the per-area outcomes, the concerns
                   it raised and the greenlight verdict; plus the fixer-loop phase -->
              <StepTestReport v-if="testReport" :report="testReport" :phase="testPhase" />

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
                      approvalPending && !editing && !companionExceeded ? 'review-mode' : '',
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
          v-if="approvalPending && !companionExceeded"
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
          </div>

          <div class="flex-1 space-y-3 overflow-auto px-4 py-3">
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
                class="rounded-lg border border-indigo-500/40 bg-indigo-500/5 p-3"
              >
                <div class="mb-1 text-[10px] uppercase tracking-wide text-indigo-300">
                  {{ t('panels.stepDetail.commentingOn') }}
                </div>
                <pre
                  class="mb-2 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-slate-950/60 p-2 text-[11px] text-slate-300"
                  >{{ draftTarget.quotedSource }}</pre
                >
                <UTextarea
                  v-model="draftBody"
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
                  >{{ c.quotedSource }}</pre
                >
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
          <div v-if="editing" class="space-y-2 border-t border-slate-800 px-4 py-3">
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

          <div v-else class="space-y-2 border-t border-slate-800 px-4 py-3">
            <UButton
              color="primary"
              data-testid="step-approve"
              size="sm"
              icon="i-lucide-check"
              block
              :disabled="rejectArmed"
              :loading="submitting"
              @click="approve"
            >
              {{ t('panels.stepDetail.approveAndProceed') }}
            </UButton>
            <UButton
              color="primary"
              variant="soft"
              size="sm"
              icon="i-lucide-pencil"
              block
              :disabled="rejectArmed || submitting"
              @click="startEditing"
            >
              {{ t('panels.stepDetail.approveWithCorrections') }}
            </UButton>

            <!-- destructive: a two-step inline confirm instead of a native dialog -->
            <div
              v-if="rejectArmed"
              class="rounded-lg border border-rose-500/40 bg-rose-500/5 p-2.5"
            >
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
                :disabled="!canRequestChanges"
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
                :disabled="submitting"
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
    </Transition>
  </Teleport>
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

/* Approval mode: each source-mapped block becomes a comment target — a hover
   highlight + a "+" gutter affordance, GitHub-review style. */
.reader-prose.review-mode :deep([data-src-start]) {
  position: relative;
  cursor: pointer;
  border-radius: 0.375rem;
  transition: background 0.12s ease;
}
.reader-prose.review-mode :deep([data-src-start]:hover) {
  background: rgb(99 102 241 / 0.08);
  box-shadow: inset 2px 0 0 rgb(99 102 241 / 0.5);
}
.reader-prose.review-mode :deep([data-src-start])::before {
  content: '+';
  position: absolute;
  left: -1.4rem;
  top: 0.1rem;
  display: none;
  height: 1.1rem;
  width: 1.1rem;
  align-items: center;
  justify-content: center;
  border-radius: 0.25rem;
  background: rgb(99 102 241);
  color: white;
  font-size: 0.8rem;
  line-height: 1;
}
.reader-prose.review-mode :deep([data-src-start]:hover)::before {
  display: flex;
}
/* Persistent markers: amber for a block that already has a comment, indigo for
   the block whose composer is currently open. */
.reader-prose :deep(.cf-commented) {
  background: rgb(234 179 8 / 0.1);
  box-shadow: inset 2px 0 0 rgb(234 179 8 / 0.6);
}
.reader-prose :deep(.cf-selected) {
  background: rgb(99 102 241 / 0.12);
  box-shadow: inset 2px 0 0 rgb(99 102 241 / 0.8);
}

/* Styling for the markdown HTML injected via v-html (out of scoped reach without
   :deep), kept close to the inspector's existing prose styling. */
.reader-prose :deep(p) {
  margin: 0.5rem 0;
}
.reader-prose :deep(ul),
.reader-prose :deep(ol) {
  margin: 0.5rem 0;
  padding-left: 1.25rem;
}
.reader-prose :deep(ul) {
  list-style: disc;
}
.reader-prose :deep(ol) {
  list-style: decimal;
}
.reader-prose :deep(li) {
  margin: 0.2rem 0;
}
.reader-prose :deep(strong) {
  font-weight: 600;
  color: rgb(226 232 240);
}
.reader-prose :deep(em) {
  font-style: italic;
}
.reader-prose :deep(code) {
  border-radius: 0.25rem;
  background: rgb(30 41 59 / 0.8);
  padding: 0.1rem 0.3rem;
  font-family: ui-monospace, monospace;
  font-size: 0.85em;
  color: rgb(199 210 254);
}
.reader-prose :deep(pre) {
  margin: 0.6rem 0;
  overflow: auto;
  border-radius: 0.5rem;
  background: rgb(2 6 23 / 0.6);
  padding: 0.75rem 0.9rem;
}
.reader-prose :deep(pre code) {
  background: transparent;
  padding: 0;
  color: rgb(203 213 225);
}
.reader-prose :deep(blockquote) {
  margin: 0.6rem 0;
  border-left: 3px solid rgb(99 102 241 / 0.5);
  padding-left: 0.75rem;
  color: rgb(148 163 184);
}
.reader-prose :deep(table) {
  margin: 0.6rem 0;
  border-collapse: collapse;
  font-size: 0.95em;
}
.reader-prose :deep(th),
.reader-prose :deep(td) {
  border: 1px solid rgb(51 65 85);
  padding: 0.3rem 0.6rem;
}
.reader-prose :deep(th) {
  background: rgb(30 41 59 / 0.6);
  font-weight: 600;
}
.reader-prose :deep(hr) {
  margin: 1rem 0;
  border: none;
  border-top: 1px solid rgb(51 65 85);
}
.reader-prose :deep(h1),
.reader-prose :deep(h2),
.reader-prose :deep(h3),
.reader-prose :deep(h4) {
  margin: 0.6rem 0 0.3rem;
  font-weight: 600;
  color: rgb(226 232 240);
}
</style>
