<script setup lang="ts">
// The interactive-planning Q&A window (slice 2) — the dedicated view of the initiative
// INTERVIEWER gate. While the planning run is parked, the interviewer's clarifying questions
// (pending `qa` entries with an empty answer) are shown here; the human answers them, then either
// SUBMITS them (the `continue` action: the interviewer re-runs and may ask follow-ups) or plans
// now (the `proceed` action: skip the remaining questions — the interviewer converges and the run
// advances to the analyst/planner). The labels say submit/plan-now rather than continue/proceed
// because the latter pair both read as "go forward" and were indistinguishable in use.
// Opened via the universal result-view host: from the inspector / card
// (`ui.openInitiativePlanning`) or as the interviewer step's result view. Live `initiative`
// stream events patch the store, so an open window follows the interview as it progresses.
//
// CONTINUE/PROCEED ARE ASYNC. They only record the intent on the parked step and wake the durable
// driver; the interviewer LLM then runs for as long as it takes, and the response carries the
// PRE-resume entity. So the window must not key its body on the entity alone — that renders
// identically before and after the click, which reads as the button having done nothing. The
// phase below folds the planning RUN's status in, so the wait is visible and a failed pass says
// so instead of leaving the human staring at questions they already submitted.
import { computed, reactive, watch } from 'vue'
import ClarificationItem from '~/components/common/ClarificationItem.vue'
import { initiativeInterviewPhase, INITIATIVE_STATUS_LABEL_KEYS } from '~/utils/initiative'
import ResultWindowShell from '~/components/panels/ResultWindowShell.vue'

const board = useBoardStore()
const initiatives = useInitiativesStore()
const execution = useExecutionStore()
const { t } = useI18n()

const { open, blockId, close } = useResultView('initiative-planning', {
  onOpen: ({ blockId }) => void initiatives.load(blockId),
})

const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const initiative = computed(() => (blockId.value ? initiatives.forBlock(blockId.value) : null))
const run = computed(() => (blockId.value ? execution.getByBlock(blockId.value) : undefined))

/** Every interview exchange, with a stable key for the list + draft map. */
const questions = computed(() =>
  (initiative.value?.qa ?? []).map((q, i) => ({ ...q, key: q.id ?? `q-${i}` })),
)
/** Questions still needing an answer: not dismissed, and not yet answered (mirrors backend). */
const pending = computed(() =>
  questions.value.filter((q) => q.status !== 'dismissed' && !(q.answer ?? '').trim()),
)

// Per-question answer drafts, seeded from the entity and refreshed as new rounds arrive
// without clobbering an answer the human is mid-edit on.
const drafts = reactive<Record<string, string>>({})
watch(
  questions,
  (list) => {
    for (const q of list) {
      if (!(q.key in drafts)) drafts[q.key] = q.answer ?? ''
    }
  },
  { immediate: true },
)

const resuming = computed(() => initiatives.resuming)

/**
 * The live phase (see `initiativeInterviewPhase`). `resuming` folds in the request itself so the
 * body swaps to the waiting state on the click rather than a beat later when the run's `running`
 * event lands — and if the request fails, `resuming` clears and the phase falls back to whatever
 * the run actually says, so the questions come back rather than the window sticking on a spinner.
 */
const phase = computed(() =>
  resuming.value
    ? 'working'
    : initiativeInterviewPhase(initiative.value?.interview, run.value?.status),
)

/**
 * Questions still missing a drafted answer. Continue is only meaningful once this is empty — but a
 * disabled button with no stated reason is itself a "nothing happened", so the count is rendered.
 * A dismissed question doesn't count (it was set aside), so an all-dismissed round is trivially
 * answered.
 */
const unanswered = computed(() => pending.value.filter((q) => !drafts[q.key]?.trim()).length)

/**
 * Persist one answer if its draft differs from what's recorded. A `dismissed` question is skipped:
 * it was set aside (its server answer cleared), and the `flushThen` sweep on continue/proceed must
 * NOT write a stale local draft back to it — that would silently re-answer a not-relevant question
 * and leak it into the converged digest.
 */
async function persist(q: {
  id?: string
  key: string
  answer?: string
  status?: 'open' | 'dismissed'
}) {
  const id = q.id
  if (!id || !blockId.value || q.status === 'dismissed') return
  const next = (drafts[q.key] ?? '').trim()
  if (!next || next === (q.answer ?? '').trim()) return
  await initiatives.answerQuestion(blockId.value, id, next)
}

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

/** Adopt a suggested answer into the draft, then persist it. */
async function useRecommendation(q: { id?: string; key: string; recommendation?: string | null }) {
  if (!q.recommendation) return
  drafts[q.key] = q.recommendation
  await persist(q)
}

/** Flush all dirty drafts, then run a window action (continue / proceed). */
async function flushThen(action: (id: string) => Promise<unknown>) {
  if (!blockId.value) return
  for (const q of questions.value) await persist(q)
  await action(blockId.value)
}

const onContinue = () => flushThen((id) => initiatives.continuePlanning(id))
const onProceed = () => flushThen((id) => initiatives.proceedPlanning(id))
</script>

<template>
  <ResultWindowShell
    :open="open"
    icon="i-lucide-messages-square"
    icon-class="bg-indigo-500/15 text-indigo-300"
    :title="initiative?.title ?? block?.title ?? t('initiative.planning.title')"
    :subtitle="t('initiative.planning.subtitle')"
    width="3xl"
    testid="initiative-planning-window"
    @close="close"
  >
    <template v-if="initiative" #header-extras>
      <UBadge color="primary" variant="subtle" size="sm">
        {{ t(INITIATIVE_STATUS_LABEL_KEYS[initiative.status]) }}
      </UBadge>
    </template>

    <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
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

        <!-- An interviewer pass is running: the human is waiting on the planner. Without this the
             window is byte-identical to the parked state and the submit reads as a no-op. -->
        <div
          v-if="phase === 'working'"
          class="flex flex-col items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 p-6 text-center"
          data-testid="initiative-planning-working"
        >
          <UIcon name="i-lucide-loader-circle" class="h-5 w-5 animate-spin text-indigo-300" />
          <p class="text-[13px] text-slate-200">{{ t('initiative.planning.working') }}</p>
          <p class="text-[12px] text-slate-400">{{ t('initiative.planning.workingHint') }}</p>
        </div>

        <!-- The planning run stopped before the interview settled — a dead end otherwise. -->
        <div
          v-else-if="phase === 'failed'"
          class="rounded-lg border border-red-900/60 bg-red-950/20 p-4 text-center"
          data-testid="initiative-planning-failed"
        >
          <p class="text-[13px] text-red-200">{{ t('initiative.planning.failed') }}</p>
          <p class="mt-1 text-[12px] text-slate-400">{{ t('initiative.planning.failedHint') }}</p>
        </div>

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
          <li v-for="q in questions" :key="q.key" data-testid="initiative-planning-question">
            <ClarificationItem
              v-model:answer="drafts[q.key]"
              :prompt="q.question"
              :dismissed="q.status === 'dismissed'"
              :recommendation="q.recommendation"
              :recommending="!!q.id && initiatives.recommending.has(q.id)"
              :answer-placeholder="t('initiative.planning.answerPlaceholder')"
              @persist="persist(q)"
              @dismiss="setStatus(q, 'dismissed')"
              @reopen="setStatus(q, 'open')"
              @recommend="recommend(q)"
              @use-recommendation="useRecommendation(q)"
            />
          </li>
        </ul>
      </template>
    </div>

    <!-- Action rail. Only while the run is actually parked on the human: mid-pass these would
         re-submit a question set already in flight, and the resume is a no-op once it isn't. -->
    <footer
      v-if="initiative && phase === 'awaiting' && questions.length > 0"
      class="flex items-center justify-between gap-3 border-t border-slate-800 px-5 py-3"
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
      <div class="flex items-center gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          :loading="resuming"
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
          :disabled="unanswered > 0"
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
