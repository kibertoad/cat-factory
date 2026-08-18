<script setup lang="ts">
// The interactive-planning Q&A window (slice 2) — the dedicated view of the initiative
// INTERVIEWER gate. While the planning run is parked, the interviewer's clarifying questions
// (pending `qa` entries with an empty answer) are shown here; the human answers them, then either
// SUBMITS them (the `continue` action: the interviewer re-runs and may ask follow-ups) or plans
// now (the `proceed` action: skip the remaining questions — the interviewer converges and the run
// advances to the planner; the analyst already ran, ahead of this gate). The labels say
// submit/plan-now rather than continue/proceed because the latter pair both read as "go forward"
// and were indistinguishable in use.
// Opened via the universal result-view host: from the inspector / card
// (`ui.openInitiativePlanning`) or as the interviewer step's result view. Live `initiative`
// stream events patch the store, so an open window follows the interview as it progresses.
//
// An interview runs over MULTIPLE ROUNDS and the entity keeps the settled ones, so the list is a
// mix of what the human still owes an answer and what they already dealt with. It renders pending
// first (`orderInterviewQuestions`) — see the `order` snapshot below for why that is recomputed per
// round rather than live.
//
// CONTINUE/PROCEED ARE ASYNC. They only record the intent on the parked step and wake the durable
// driver; the interviewer LLM then runs for as long as it takes, and the response carries the
// PRE-resume entity. So the window must not key its body on the entity alone — that renders
// identically before and after the click, which reads as the button having done nothing. The
// phase below folds the planning RUN's status in, so the wait is visible and a failed pass says
// so instead of leaving the human staring at questions they already submitted.
import { computed, ref, watch } from 'vue'
import ClarificationItem from '~/components/common/ClarificationItem.vue'
import InterviewGateNotice from '~/components/common/InterviewGateNotice.vue'
import {
  INITIATIVE_STATUS_LABEL_KEYS,
  isPendingQuestion,
  orderInterviewQuestions,
} from '~/utils/initiative'
import {
  INITIATIVE_INTERVIEWER_KIND,
  interviewGatePhase,
  interviewStepReached,
} from '~/utils/interviewGate'
import ResultWindowShell from '~/components/panels/ResultWindowShell.vue'
import StepRunMeta from '~/components/panels/StepRunMeta.vue'

const board = useBoardStore()
const initiatives = useInitiativesStore()
const { t } = useI18n()

const { open, blockId, instanceId, stepIndex, close } = useResultView('initiative-planning', {
  onOpen: ({ blockId }) => void initiatives.load(blockId),
  // Persist any typed-but-unsubmitted answer before the view tears down (X, backdrop, Escape), so
  // closing the window never silently drops it (UX-79). A flush rather than a discard prompt because
  // saving ONE answer is a plain save: it records the reply without resuming the interview, which is
  // what this window's own two commands do.
  onClose: () => flushOnClose(),
})

const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const initiative = computed(() => (blockId.value ? initiatives.forBlock(blockId.value) : null))

/**
 * The planning run + the interviewer step's run details, resolved through the shared seam so this
 * window reports the same "which run is this / how did the model do" facts as every other agent
 * window — including on the card/inspector entry point, which carries no step (see
 * `useResultViewRunMeta`). `run` is the same instance the phase below reads.
 */
const {
  instance: run,
  step: metaStep,
  instanceId: runId,
  position,
  totalSteps,
  runFailed,
  failureAt,
} = useResultViewRunMeta('initiative-planning', {
  blockId: () => blockId.value,
  instanceId: () => instanceId.value,
  stepIndex: () => stepIndex.value,
})

/** Every interview exchange, with a stable key for the list + draft map. */
const questions = computed(() =>
  (initiative.value?.qa ?? []).map((q, i) => ({ ...q, key: q.id ?? `q-${i}` })),
)
/** Questions still needing an answer: not dismissed, and not yet answered (mirrors backend). */
const pending = computed(() => questions.value.filter(isPendingQuestion))

// Per-question answer drafts, plus the two ways they leave the browser: one on blur, all of them on
// the way out. The shared seam with the doc-authoring interviewer, which holds the same kind of draft
// for the same reason; `useInterviewDrafts` records what a per-window copy kept getting wrong.
//
// `writable` is this window's own rule: a question set aside as not-relevant had its recorded answer
// CLEARED, so writing a stale local draft back would silently re-answer it and leak it into the
// converged digest.
const { drafts, addressable, unanswered, saveAnswer, flushDrafts, flushThen } = useInterviewDrafts({
  blockId: () => blockId.value,
  questions: () => questions.value,
  pending: () => pending.value,
  write: (block, questionId, answer) => initiatives.answerQuestion(block, questionId, answer),
  writable: (q) => q.status !== 'dismissed',
  failureTitleKeys: {
    one: 'initiative.planning.saveFailed',
    many: 'initiative.planning.saveFailedCount',
  },
})

/**
 * A hoisted indirection for the close hook above. The seam that owns `flushDrafts` needs the
 * `blockId` this very `useResultView` call produces, so the hook cannot name the const directly.
 */
function flushOnClose(): void {
  flushDrafts()
}

/**
 * Render order (pending first — see `orderInterviewQuestions`), re-snapshotted ONLY when the
 * question SET changes, i.e. when a round lands. Deriving it live from the answers instead would
 * yank a question out from under the human the moment they blurred its textarea and shuffle
 * everything below it up, while they are reading down the list. Re-snapshotting per ROUND rather
 * than per question is what keeps a window left open across rounds correct: a question answered in
 * round one has to sink below round two's new ones, which a rank frozen at first sight never would.
 */
const order = ref<string[]>([])
watch(
  () => questions.value.map((q) => q.key).join('|'),
  () => {
    order.value = orderInterviewQuestions(questions.value).map((q) => q.key)
  },
  { immediate: true },
)
const orderedQuestions = computed(() => {
  const rank = new Map(order.value.map((key, i) => [key, i]))
  // A question the snapshot has not seen is by definition new, so it is pending and sorts first.
  return [...questions.value].sort((a, b) => (rank.get(a.key) ?? -1) - (rank.get(b.key) ?? -1))
})

const resuming = computed(() => initiatives.resuming)

/**
 * The live phase (see `interviewGatePhase`). `resuming` folds in the request itself so the
 * body swaps to the waiting state on the click rather than a beat later when the run's `running`
 * event lands — and if the request fails, `resuming` clears and the phase falls back to whatever
 * the run actually says, so the questions come back rather than the window sticking on a spinner.
 */
const phase = computed(() =>
  resuming.value
    ? 'working'
    : interviewGatePhase(
        initiative.value?.interview?.status,
        run.value?.status,
        interviewStepReached(run.value, INITIATIVE_INTERVIEWER_KIND),
      ),
)

/** Mark a question not-relevant / reopen it. */
async function setStatus(q: { id?: string }, status: 'open' | 'dismissed') {
  if (!q.id || !blockId.value) return
  await initiatives.setQuestionStatus(blockId.value, q.id, status)
}

/** Ask the interviewer to draft a suggested answer for this question. */
async function recommend(q: { id?: string }) {
  if (!q.id || !blockId.value) return
  await initiatives.recommendAnswer(blockId.value, q.id)
}

/** Adopt a suggested answer into the draft, then record it. */
function useRecommendation(q: (typeof questions.value)[number]) {
  if (!q.recommendation) return
  drafts[q.key] = q.recommendation
  saveAnswer(q)
}

const onContinue = () =>
  flushThen((id) => initiatives.continuePlanning(id), 'initiative.planning.continueFailed')
const onProceed = () =>
  flushThen((id) => initiatives.proceedPlanning(id), 'initiative.planning.proceedFailed')

/**
 * The escape hatch for a planning run that stalled. It belongs HERE, not only in the inspector's
 * execution panel behind this window: submit and plan-now are the two things that wedge, so the
 * human who needs a way out is looking at exactly this footer. Offered whenever a run still owns
 * the block — including mid-pass and after a failed pass, which is where a wedge actually shows up
 * and where neither of the other two buttons is even rendered.
 *
 * Discarding returns the block to `planned`, which re-enables "Run planning"; the interviewer gate
 * drops the previous run's round bookkeeping on that fresh start, so the re-run genuinely
 * re-interviews instead of force-converging on its first pass. Close on success — leaving the
 * window open on the now-empty idle state would read as another dead end.
 */
const { resetting, resetRun } = useRunReset()
const canDiscard = computed(() => !!block.value?.executionId)
async function onDiscard() {
  if (!blockId.value) return
  if (await resetRun(blockId.value)) close()
}
</script>

<template>
  <ResultWindowShell
    :open="open"
    icon="i-lucide-messages-square"
    icon-class="bg-indigo-500/15 text-indigo-300"
    :title="initiative?.title ?? block?.title ?? t('initiative.planning.title')"
    :subtitle="t('initiative.planning.subtitle')"
    width="4xl"
    testid="initiative-planning-window"
    @close="close"
  >
    <template v-if="initiative" #header-extras>
      <UBadge color="primary" variant="subtle" size="sm">
        {{ t(INITIATIVE_STATUS_LABEL_KEYS[initiative.status]) }}
      </UBadge>
    </template>

    <div class="flex min-h-0 flex-1">
      <div class="min-w-0 flex-1 overflow-y-auto px-5 py-4">
        <!-- No entity yet -->
        <div
          v-if="!initiative"
          class="flex h-full flex-col items-center justify-center gap-2 text-center text-slate-400"
        >
          <UIcon name="i-lucide-messages-square" class="h-8 w-8 opacity-40" />
          <p class="text-sm">{{ t('initiative.planning.empty') }}</p>
        </div>

        <template v-else>
          <p class="mb-4 text-[13px] leading-relaxed text-slate-300">
            {{ t('initiative.planning.intro') }}
          </p>

          <!-- The run is still ahead of the interview — the codebase analysis that grounds it. It
               wears the working chrome but says something different on purpose: nothing has been
               asked yet, so "working on your answers" would describe answers that do not exist. -->
          <InterviewGateNotice
            v-if="phase === 'preparing'"
            variant="working"
            :title="t('initiative.planning.preparing')"
            :hint="t('initiative.planning.preparingHint')"
            testid="initiative-planning-preparing"
          />

          <!-- A pass is running: the human is waiting on the planner. Without this the window is
               byte-identical to the parked state and the submit reads as a no-op. -->
          <InterviewGateNotice
            v-else-if="phase === 'working'"
            variant="working"
            :title="t('initiative.planning.working')"
            :hint="t('initiative.planning.workingHint')"
            testid="initiative-planning-working"
          />

          <!-- The planning run stopped before the interview settled — a dead end otherwise. -->
          <InterviewGateNotice
            v-else-if="phase === 'failed'"
            variant="failed"
            :title="t('initiative.planning.failed')"
            :hint="t('initiative.planning.failedHint')"
            testid="initiative-planning-failed"
          />

          <!-- Planning was never started, so there is nothing to answer YET (distinct from
               converged, which means the planner already has what it needs). -->
          <div
            v-else-if="phase === 'idle' && questions.length === 0"
            class="rounded-lg border border-slate-800 bg-slate-950/40 p-4 text-center text-[13px] text-slate-400"
            data-testid="initiative-planning-idle"
          >
            {{ t('initiative.planning.idle') }}
          </div>

          <!-- Converged / no pending questions -->
          <div
            v-else-if="phase === 'converged' || questions.length === 0"
            class="rounded-lg border border-slate-800 bg-slate-950/40 p-4 text-center text-[13px] text-slate-400"
            data-testid="initiative-planning-converged"
          >
            {{ t('initiative.planning.converged') }}
          </div>

          <!-- Interview questions — the shared clarification surface (answer / not-relevant /
                   recommend), reused with the requirements-review window. -->
          <ul v-else class="space-y-4">
            <li
              v-for="q in orderedQuestions"
              :key="q.key"
              data-testid="initiative-planning-question"
            >
              <ClarificationItem
                v-model:answer="drafts[q.key]"
                :prompt="q.question"
                :dismissed="q.status === 'dismissed'"
                :recommendation="q.recommendation"
                :recommending="!!q.id && initiatives.recommending.has(q.id)"
                :disabled="!addressable(q)"
                :answer-placeholder="t('initiative.planning.answerPlaceholder')"
                @persist="saveAnswer(q)"
                @dismiss="setStatus(q, 'dismissed')"
                @reopen="setStatus(q, 'open')"
                @recommend="recommend(q)"
                @use-recommendation="useRecommendation(q)"
              />
              <!-- Every action here addresses a question by id, so an exchange without one has
                   nowhere for an answer (or a dismissal) to go. Saying so beats taking text the
                   flush could only drop. -->
              <p
                v-if="!addressable(q)"
                class="mt-1 text-[11px] text-amber-300"
                data-testid="initiative-planning-unanswerable"
              >
                {{ t('initiative.planning.unanswerable') }}
              </p>
            </li>
          </ul>
        </template>
      </div>

      <!-- Run details: the shared run-metadata + LLM model-activity block every agent window
           carries (step position, live duration, model, run id, calls + token usage). Resolved
           through `useResultViewRunMeta`, so it is present on the card / inspector entry point
           too — where this window carries no step index of its own. -->
      <aside
        v-if="metaStep"
        data-testid="initiative-planning-run-meta"
        class="hidden w-60 shrink-0 flex-col gap-4 overflow-y-auto border-s border-slate-800 bg-slate-900/50 px-4 py-4 lg:flex"
      >
        <StepRunMeta
          :step="metaStep"
          :instance-id="runId"
          :step-number="position"
          :total-steps="totalSteps"
          :run-failed="runFailed"
          :failure-at="failureAt"
        />
      </aside>
    </div>

    <!-- Action rail. The submit/plan-now pair shows only while the run is actually parked on the
         human: mid-pass they would re-submit a question set already in flight, and the resume is a
         no-op once it isn't. Discard is the opposite — it is offered for as long as a run owns the
         block, because the phases where those two are hidden (preparing, working, failed) are
         exactly the ones a wedged run sits in. -->
    <footer
      v-if="initiative && (canDiscard || (phase === 'awaiting' && questions.length > 0))"
      class="flex items-center justify-between gap-3 border-t border-slate-800 px-5 py-3"
    >
      <UButton
        v-if="canDiscard"
        color="error"
        variant="ghost"
        size="sm"
        icon="i-lucide-trash-2"
        :loading="resetting"
        :disabled="resuming"
        :title="t('initiative.planning.discardTitle')"
        data-testid="initiative-planning-discard"
        @click="onDiscard"
      >
        {{ t('initiative.planning.discard') }}
      </UButton>
      <!-- `ms-auto` rather than relying on `justify-between`: discard is conditional, and without
           it this group left-aligns on the (transient) render where it is the only child. -->
      <div
        v-if="phase === 'awaiting' && questions.length > 0"
        class="ms-auto flex items-center gap-2"
      >
        <p class="text-[11px] text-slate-500">
          <span
            v-if="unanswered > 0"
            class="text-amber-400/90"
            data-testid="initiative-planning-unanswered"
          >
            {{ t('initiative.planning.unanswered', { count: unanswered }) }}
          </span>
          <span v-else>{{ t('initiative.planning.hint') }}</span>
        </p>
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          :loading="resuming"
          :disabled="resetting"
          :title="t('initiative.planning.proceedTitle')"
          data-testid="initiative-planning-proceed"
          @click="onProceed"
        >
          {{ t('initiative.planning.proceed') }}
        </UButton>
        <UButton
          color="primary"
          size="sm"
          :loading="resuming"
          :disabled="unanswered > 0 || resetting"
          :title="
            unanswered > 0
              ? t('initiative.planning.unanswered', { count: unanswered })
              : t('initiative.planning.continueTitle')
          "
          data-testid="initiative-planning-continue"
          @click="onContinue"
        >
          {{ t('initiative.planning.continue') }}
        </UButton>
      </div>
    </footer>
  </ResultWindowShell>
</template>
