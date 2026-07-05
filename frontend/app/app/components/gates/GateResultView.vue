<script setup lang="ts">
// Gate window — the dedicated surface for a polling gate step (`ci` / `conflicts`),
// opened via the universal result-view host (the same seam the test report and the
// requirements review use). It surfaces the gate's conclusion that the backend now
// persists on `step.gate`: the precheck verdict, the helper attempt budget, the gated
// commit, and — for CI — the failing checks behind the failure. One window serves both
// gates; it branches on the step's `agentKind` for the copy and the failure detail.
import { computed, ref } from 'vue'
import { agentKindMeta } from '~/utils/catalog'
import type { GateAttempt, GateStepState } from '~/types/execution'
import StepRestartControl from '~/components/panels/StepRestartControl.vue'
import StepRunMeta from '~/components/panels/StepRunMeta.vue'
import AttemptEntryHeader from '~/components/panels/AttemptEntryHeader.vue'
import GateFailingCheckList from '~/components/gates/GateFailingCheckList.vue'
import CopyButton from '~/components/common/CopyButton.vue'

const board = useBoardStore()
const execution = useExecutionStore()
const { t } = useI18n()

// Synchronous window: it reads its state straight off the execution step, so there's
// nothing to fetch on open (no `onOpen` loader).
const { open, blockId, instanceId, stepIndex, close } = useResultView('gate')
const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const prUrl = computed(() => block.value?.pullRequest?.url ?? null)

const instance = computed(() =>
  instanceId.value === null ? null : (execution.getInstance(instanceId.value) ?? null),
)
const step = computed(() => {
  if (instance.value === null || stepIndex.value === null) return null
  return instance.value.steps[stepIndex.value] ?? null
})
const gate = computed<GateStepState | null>(() => step.value?.gate ?? null)

const isCi = computed(() => step.value?.agentKind === 'ci')
const isHumanReview = computed(() => step.value?.agentKind === 'human-review')
const isDocQuality = computed(() => step.value?.agentKind === 'doc-quality')
const meta = computed(() => agentKindMeta(step.value?.agentKind ?? 'ci'))
const helperKind = computed(() =>
  isHumanReview.value
    ? 'fixer'
    : isCi.value
      ? 'ci-fixer'
      : isDocQuality.value
        ? 'doc-fixer'
        : 'conflict-resolver',
)
const helperMeta = computed(() => agentKindMeta(helperKind.value))

const subtitle = computed(() =>
  isHumanReview.value
    ? t('gates.subtitle.humanReview')
    : isCi.value
      ? t('gates.subtitle.ci')
      : isDocQuality.value
        ? t('gates.subtitle.docQuality')
        : t('gates.subtitle.conflicts'),
)

// Human-review: approval progress + the freeform "request a fix" control.
const humanReview = useHumanReviewStore()
const fixInstructions = ref('')
const fixBusy = computed(() => (blockId.value ? humanReview.isBusy(blockId.value) : false))
async function submitFix() {
  const id = blockId.value
  const text = fixInstructions.value.trim()
  if (!id || !text) return
  await humanReview.requestFix(id, text)
  fixInstructions.value = ''
}

// The displayed "required approvals" is derived from the cached branch-protection count via
// the gate's effective floor (`max(1, …)`, see review.logic.ts) rather than persisted twice.
const requiredApprovals = computed(() => Math.max(1, gate.value?.requiredApprovingReviewCount ?? 1))

const failingChecks = computed(() => gate.value?.failingChecks ?? [])
const shortSha = computed(() => (gate.value?.headSha ? gate.value.headSha.slice(0, 7) : null))

// The helper-agent attempts this gate dispatched, newest first for the timeline.
const attempts = computed(() => [...(gate.value?.attemptLog ?? [])].reverse())

// Exhaustive map of the attempt outcome enum → label (literal keys keep the typed-key
// drift guard live, vs a runtime-built `gates.outcome.${outcome}`).
const OUTCOME_LABELS = computed<Record<GateAttempt['outcome'], string>>(() => ({
  completed: t('gates.outcome.completed'),
  failed: t('gates.outcome.failed'),
}))

/**
 * The display status — a roll-up of the persisted gate state + the run's status, so the
 * window reads as a conclusion rather than raw fields:
 *  - `passed`   — the step finished (the precheck went green; the helper was never needed
 *                 or fixed it);
 *  - `gave-up`  — the run failed at this gate (attempt budget spent);
 *  - `fixing`   — a helper agent is in flight on a failed precheck;
 *  - `failing`  — the precheck failed and a helper is about to run;
 *  - `pending`  — the provider is still computing;
 *  - `checking` — running the precheck.
 */
type GateDisplayStatus = 'passed' | 'gave-up' | 'fixing' | 'failing' | 'pending' | 'checking'
const status = computed<GateDisplayStatus>(() => {
  const s = step.value
  if (!s) return 'checking'
  if (s.state === 'done') return 'passed'
  if (instance.value?.status === 'failed') return 'gave-up'
  if (gate.value?.phase === 'working') return 'fixing'
  if (gate.value?.lastVerdict === 'fail') return 'failing'
  if (gate.value?.lastVerdict === 'pending') return 'pending'
  return 'checking'
})

const STATUS_META = computed<
  Record<
    GateDisplayStatus,
    {
      label: string
      badge: 'success' | 'warning' | 'error' | 'neutral'
      icon: string
      text: string
    }
  >
>(() => ({
  passed: {
    label: t('gates.status.passed'),
    badge: 'success',
    icon: 'i-lucide-circle-check',
    text: 'text-emerald-300',
  },
  'gave-up': {
    label: t('gates.status.gaveUp'),
    badge: 'error',
    icon: 'i-lucide-circle-x',
    text: 'text-rose-300',
  },
  fixing: {
    label: t('gates.status.fixing'),
    badge: 'warning',
    icon: 'i-lucide-loader',
    text: 'text-amber-300',
  },
  failing: {
    label: t('gates.status.failing'),
    badge: 'error',
    icon: 'i-lucide-circle-x',
    text: 'text-rose-300',
  },
  pending: {
    label: t('gates.status.pending'),
    badge: 'neutral',
    icon: 'i-lucide-clock',
    text: 'text-slate-300',
  },
  checking: {
    label: t('gates.status.checking'),
    badge: 'neutral',
    icon: 'i-lucide-loader',
    text: 'text-slate-300',
  },
}))

// The conflicts gate has no structured detail (GitHub reports mergeability as a single
// verdict, no file list), so the window shows the verdict + a note rather than a list.
const conflictVerdict = computed(() => {
  if (status.value === 'passed') return t('gates.conflict.mergeable')
  if (gate.value?.lastVerdict === 'pending') return t('gates.conflict.computing')
  if (gate.value?.lastVerdict === 'fail') return t('gates.conflict.conflicts')
  return t('gates.conflict.unknown')
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex max-h-[100dvh] items-stretch justify-center bg-slate-950/70 backdrop-blur-sm"
      @click.self="close"
    >
      <div
        class="m-4 flex w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl"
        role="dialog"
        aria-modal="true"
      >
        <!-- Header -->
        <header class="flex items-center gap-3 border-b border-slate-800 px-5 py-3">
          <span
            class="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/15 text-sky-300"
          >
            <UIcon :name="meta.icon" class="h-4 w-4" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="truncate text-sm font-semibold text-slate-100">
              {{ meta.label }}{{ block ? ` — ${block.title}` : '' }}
            </h2>
            <p class="truncate text-[11px] text-slate-400">{{ subtitle }}</p>
          </div>
          <UBadge :color="STATUS_META[status].badge" variant="subtle" size="sm">
            {{ STATUS_META[status].label }}
          </UBadge>
          <StepRestartControl
            :instance-id="instanceId"
            :step-index="stepIndex"
            @restarted="close"
          />
          <button
            class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            @click="close"
          >
            <UIcon name="i-lucide-x" class="h-4 w-4" />
          </button>
        </header>

        <div class="flex min-h-0 flex-1">
          <!-- Main: the conclusion -->
          <div class="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            <div
              v-if="!gate"
              class="flex h-full flex-col items-center justify-center gap-2 text-center text-slate-400"
            >
              <UIcon :name="meta.icon" class="h-8 w-8 opacity-40" />
              <p class="text-sm">{{ t('gates.noActivity') }}</p>
              <p class="max-w-sm text-[11px] text-slate-500">
                {{ t('gates.noActivityHint') }}
              </p>
            </div>

            <template v-else>
              <!-- Passed -->
              <div
                v-if="status === 'passed'"
                class="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5"
              >
                <UIcon
                  name="i-lucide-circle-check"
                  class="mt-0.5 h-4 w-4 shrink-0 text-emerald-400"
                />
                <p class="text-[13px] leading-relaxed text-emerald-200">
                  {{ step?.output || (isCi ? t('gates.passedCi') : t('gates.passedConflicts')) }}
                </p>
              </div>

              <!-- Human review: approval progress, the feedback being fixed, freeform fix box -->
              <template v-else-if="isHumanReview">
                <div
                  class="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2"
                >
                  <UIcon name="i-lucide-users" class="h-4 w-4 shrink-0 text-violet-300" />
                  <span class="text-[13px] text-slate-200">
                    {{
                      t(
                        'gates.humanReview.approvals',
                        { approved: gate.lastApprovals ?? 0, required: requiredApprovals },
                        requiredApprovals,
                      )
                    }}
                    <template v-if="status === 'fixing'">
                      {{ t('gates.humanReview.suffixFixing') }}</template
                    >
                    <template v-else-if="status === 'failing'">
                      {{ t('gates.humanReview.suffixFailing') }}</template
                    >
                    <template v-else> {{ t('gates.humanReview.suffixAwaiting') }}</template>
                  </span>
                </div>
                <div
                  v-if="gate.lastFailureSummary"
                  class="relative mt-2 rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2"
                >
                  <CopyButton :text="gate.lastFailureSummary" class="absolute end-1 top-1" />
                  <p class="whitespace-pre-wrap pe-8 text-[12px] leading-relaxed text-slate-300">
                    {{ gate.lastFailureSummary }}
                  </p>
                </div>
                <a
                  v-if="prUrl"
                  :href="prUrl"
                  target="_blank"
                  rel="noopener"
                  class="mt-2 inline-flex items-center gap-1 text-[12px] text-sky-300 hover:text-sky-200 hover:underline"
                >
                  {{ t('gates.humanReview.reviewPr') }}
                  <UIcon name="i-lucide-external-link" class="h-3 w-3" />
                </a>

                <!-- Freeform fix request: dispatch the fixer now with these instructions. -->
                <section v-if="status !== 'gave-up'" class="mt-4">
                  <h3
                    class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500"
                  >
                    {{ t('gates.humanReview.requestFixHeading') }}
                  </h3>
                  <p class="mb-2 text-[11px] leading-relaxed text-slate-500">
                    {{ t('gates.humanReview.requestFixDescription') }}
                  </p>
                  <textarea
                    v-model="fixInstructions"
                    rows="3"
                    :disabled="fixBusy"
                    :placeholder="t('gates.humanReview.requestFixPlaceholder')"
                    class="w-full resize-y rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2 text-[13px] text-slate-200 placeholder:text-slate-600 focus:border-violet-500/60 focus:outline-none"
                  />
                  <div class="mt-2 flex justify-end">
                    <UButton
                      size="sm"
                      color="primary"
                      icon="i-lucide-wrench"
                      :loading="fixBusy"
                      :disabled="fixBusy || fixInstructions.trim().length === 0"
                      @click="submitFix"
                    >
                      {{ t('gates.humanReview.requestFix') }}
                    </UButton>
                  </div>
                </section>
              </template>

              <!-- CI: failing checks -->
              <template v-else-if="isCi">
                <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {{ t('gates.ci.failingChecks') }}
                </h3>
                <GateFailingCheckList v-if="failingChecks.length" :checks="failingChecks" />
                <p v-else class="text-[13px] leading-relaxed text-slate-300">
                  {{ gate.lastFailureSummary || t('gates.ci.failureFallback') }}
                </p>
              </template>

              <!-- Doc quality: the deterministic structural findings the gate raised -->
              <template v-else-if="isDocQuality">
                <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {{ t('gates.docQuality.findings') }}
                </h3>
                <div
                  v-if="gate.lastFailureSummary"
                  class="relative rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2"
                >
                  <CopyButton :text="gate.lastFailureSummary" class="absolute end-1 top-1" />
                  <p class="whitespace-pre-wrap pe-8 text-[12px] leading-relaxed text-slate-300">
                    {{ gate.lastFailureSummary }}
                  </p>
                </div>
                <p v-else class="text-[13px] leading-relaxed text-slate-300">
                  {{ t('gates.docQuality.findingsFallback') }}
                </p>
                <a
                  v-if="prUrl"
                  :href="prUrl"
                  target="_blank"
                  rel="noopener"
                  class="mt-2 inline-flex items-center gap-1 text-[12px] text-sky-300 hover:text-sky-200 hover:underline"
                >
                  {{ t('gates.docQuality.viewPr') }}
                  <UIcon name="i-lucide-external-link" class="h-3 w-3" />
                </a>
              </template>

              <!-- Conflicts: verdict + the resolver's account of what it left -->
              <template v-else>
                <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {{ t('gates.conflicts.mergeability') }}
                </h3>
                <div
                  class="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2"
                >
                  <UIcon
                    :name="STATUS_META[status].icon"
                    class="h-4 w-4 shrink-0"
                    :class="STATUS_META[status].text"
                  />
                  <span class="text-[13px] text-slate-200">{{ conflictVerdict }}</span>
                </div>
                <!-- GitHub's API reports mergeability as a single bit (no file list), but the
                     conflict resolver discovers the conflicting files in the container and
                     reports them back — surface that account here. -->
                <div
                  v-if="gate.lastFailureSummary"
                  class="relative mt-2 rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2"
                >
                  <CopyButton :text="gate.lastFailureSummary" class="absolute end-1 top-1" />
                  <p class="whitespace-pre-wrap pe-8 text-[12px] leading-relaxed text-slate-300">
                    {{ gate.lastFailureSummary }}
                  </p>
                </div>
                <a
                  v-if="prUrl"
                  :href="prUrl"
                  target="_blank"
                  rel="noopener"
                  class="mt-2 inline-flex items-center gap-1 text-[12px] text-sky-300 hover:text-sky-200 hover:underline"
                >
                  {{ t('gates.conflicts.viewPr') }}
                  <UIcon name="i-lucide-external-link" class="h-3 w-3" />
                </a>
              </template>

              <!-- Attempt history (both gates): what each helper run did and how it ended. -->
              <section v-if="attempts.length" class="mt-5">
                <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {{ t('gates.attemptsHeading', { helper: helperMeta.label }) }}
                </h3>
                <ol class="space-y-2">
                  <li
                    v-for="a in attempts"
                    :key="a.attempt"
                    class="rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2"
                  >
                    <AttemptEntryHeader
                      :label="t('gates.attempt', { number: a.attempt })"
                      :outcome="a.outcome"
                      :outcome-label="OUTCOME_LABELS[a.outcome]"
                      :at="a.at"
                      date-format="long"
                    />
                    <!-- What this round was asked to fix: the instructions the gate handed the
                         helper (the failing-check summary / conflict reason / review comments),
                         plus the structured red checks for the CI gate. -->
                    <div
                      v-if="a.instructions || (a.failingChecks && a.failingChecks.length)"
                      class="mt-1.5"
                    >
                      <p class="text-[11px] text-slate-500">
                        {{ t('gates.attemptInstructions', { helper: helperMeta.label }) }}
                      </p>
                      <GateFailingCheckList
                        v-if="a.failingChecks && a.failingChecks.length"
                        class="mt-1"
                        :checks="a.failingChecks"
                        dense
                      />
                      <p
                        v-else-if="a.instructions"
                        class="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-slate-300"
                      >
                        {{ a.instructions }}
                      </p>
                    </div>
                    <!-- The helper's own report of what it did / what remains. -->
                    <template v-if="a.summary">
                      <p class="mt-1.5 text-[11px] text-slate-500">
                        {{ t('gates.attemptReport', { helper: helperMeta.label }) }}
                      </p>
                      <p
                        class="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-slate-400"
                      >
                        {{ a.summary }}
                      </p>
                    </template>
                  </li>
                </ol>
              </section>
            </template>
          </div>

          <!-- Sidebar: gate state -->
          <aside
            class="hidden w-60 shrink-0 flex-col gap-4 border-s border-slate-800 bg-slate-900/50 px-4 py-4 lg:flex"
          >
            <div v-if="gate">
              <h4 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('gates.sidebar.state') }}
              </h4>
              <div class="flex items-center gap-2 text-[13px]">
                <UIcon
                  :name="STATUS_META[status].icon"
                  class="h-4 w-4"
                  :class="STATUS_META[status].text"
                />
                <span :class="STATUS_META[status].text">{{ STATUS_META[status].label }}</span>
              </div>
            </div>

            <div v-if="gate">
              <h4 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ helperMeta.label }}
              </h4>
              <p class="text-[12px] text-slate-300">
                <!-- The human-review gate's budget is effectively unbounded (it waits for a human
                     indefinitely), so render a plain round count rather than "0/9007199254740991". -->
                <template v-if="isHumanReview">
                  {{ t('gates.sidebar.fixRounds', { count: gate.attempts }, gate.attempts) }}
                </template>
                <template v-else>
                  {{
                    t(
                      'gates.sidebar.attempts',
                      { attempts: gate.attempts, max: gate.maxAttempts },
                      gate.maxAttempts,
                    )
                  }}
                </template>
                <template v-if="gate.phase === 'working'">
                  {{ t('gates.sidebar.suffixRunning') }}</template
                >
                <template v-else-if="gate.attempts === 0">
                  {{ t('gates.sidebar.suffixNotNeeded') }}</template
                >
              </p>
            </div>

            <div v-if="shortSha">
              <h4 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('gates.sidebar.gatedCommit') }}
              </h4>
              <p class="font-mono text-[12px] text-slate-300">{{ shortSha }}</p>
            </div>

            <!-- Shared run metadata + embedded observability (model, run id, timing,
                 model-activity rollup) — identical to the agent step detail. -->
            <StepRunMeta
              v-if="step"
              :step="step"
              :instance-id="instanceId ?? undefined"
              :step-number="stepIndex === null ? undefined : stepIndex + 1"
              :total-steps="instance?.steps.length"
              :run-failed="instance?.status === 'failed'"
              :failure-at="instance?.failure?.occurredAt"
            />

            <p class="mt-auto text-[10px] leading-relaxed text-slate-600">
              {{ t('gates.sidebar.footer', { helper: helperMeta.label }) }}
            </p>
          </aside>
        </div>
      </div>
    </div>
  </Teleport>
</template>
