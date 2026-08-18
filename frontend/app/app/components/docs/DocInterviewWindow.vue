<script setup lang="ts">
// The interactive document-interview window (WS5) — the dedicated view of the doc-authoring
// INTERVIEWER gate. While the document run is parked between the outline and the draft, the
// interviewer's clarifying questions (pending `qa` entries with an empty answer) are shown here;
// the human answers them, then either SUBMITS them (the `continue` action: the interviewer re-runs
// and may ask follow-ups) or drafts now (the `proceed` action: skip the remaining questions — the
// interviewer converges into an authoring brief and the run advances to the writer). The labels
// say submit/draft-now rather than continue/proceed because the latter pair both read as "go
// forward" and were indistinguishable in use. Opened via the universal result-view host as the
// `doc-interviewer` step's result view. Live `docInterview` stream events patch the store, so an
// open window follows the interview as it progresses. Mirrors InitiativePlanningWindow.vue.
//
// CONTINUE/PROCEED ARE ASYNC. They only record the intent on the parked step and wake the durable
// driver; the interviewer LLM then runs for as long as it takes, and the response carries the
// PRE-resume session. So the window must not key its body on the session alone — that renders
// identically before and after the click, which reads as the button having done nothing. The
// phase below folds the document RUN's status in, so the wait is visible and a failed pass says
// so instead of leaving the human staring at questions they already submitted.
import { computed, reactive, watch } from 'vue'
import InterviewGateNotice from '~/components/common/InterviewGateNotice.vue'
import ResultWindowShell from '~/components/panels/ResultWindowShell.vue'
import {
  DOC_INTERVIEWER_KIND,
  interviewGatePhase,
  interviewStepReached,
} from '~/utils/interviewGate'

const board = useBoardStore()
const docInterview = useDocInterviewStore()
const execution = useExecutionStore()
const { t } = useI18n()
const access = useWorkspaceAccess()
const { present } = usePipelineErrorToast()

const { open, blockId, close } = useResultView('doc-interview', {
  onOpen: ({ blockId }) => void docInterview.load(blockId),
  // Persist any typed-but-unsubmitted answer before the view tears down (X, backdrop, Escape), so
  // closing the window never silently drops it (UX-79). The flush seam is right here rather than a
  // discard prompt because saving ONE answer is a plain save: it records the reply without
  // resolving the interview, which is what the window's own two commands do.
  onClose: () => flushDrafts(),
})

const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const session = computed(() => (blockId.value ? docInterview.forBlock(blockId.value) : null))
const run = computed(() => (blockId.value ? execution.getByBlock(blockId.value) : undefined))

/** Every interview exchange, with a stable key for the list + draft map. */
const questions = computed(() =>
  (session.value?.qa ?? []).map((q, i) => ({ ...q, key: q.id ?? `q-${i}` })),
)
const pending = computed(() => questions.value.filter((q) => !(q.answer ?? '').trim()))

// Per-question answer drafts, seeded from the entity and refreshed as new rounds arrive without
// clobbering an answer the human is mid-edit on.
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

const resuming = computed(() => docInterview.resuming)

/**
 * The live phase (see `interviewGatePhase`). `resuming` folds in the request itself so the body
 * swaps to the waiting state on the click rather than a beat later when the run's `running` event
 * lands — and if the request fails, `resuming` clears and the phase falls back to whatever the run
 * actually says, so the questions come back rather than the window sticking on a spinner.
 */
const phase = computed(() =>
  resuming.value
    ? 'working'
    : interviewGatePhase(
        session.value?.status,
        run.value?.status,
        interviewStepReached(run.value, DOC_INTERVIEWER_KIND),
      ),
)
/** The interview converged: the synthesized authoring brief is what the window shows. */
const converged = computed(() => phase.value === 'converged')

/**
 * Questions still missing a drafted answer. Submit is only meaningful once this is empty — but a
 * disabled button with no stated reason is itself a "nothing happened", so the count is rendered.
 */
const unanswered = computed(() => pending.value.filter((q) => !drafts[q.key]?.trim()).length)

/** Why Submit is unavailable, or undefined when it is. RBAC first: it outranks a draft gap. */
const continueBlockedReason = computed(() => {
  if (!access.canExecuteRuns.value) return t('access.noRunExecute')
  if (unanswered.value > 0) return t('docInterview.unanswered', { count: unanswered.value })
  return undefined
})

/**
 * Persist one answer if its draft differs from what's recorded. The block id is threaded in rather
 * than read off the reactive ref, so a flush started as the window closes still writes to the right
 * board: `blockId` goes null the moment the view tears down.
 */
async function persist(block: string, q: { id?: string; key: string; answer?: string }) {
  const id = q.id
  if (!id) return
  const next = (drafts[q.key] ?? '').trim()
  if (!next || next === (q.answer ?? '').trim()) return
  await docInterview.answerQuestion(block, id, next)
}

/**
 * The blur handler: save this one answer against the block that is open right now. Reports its own
 * failure — the call is detached (Vue discards a handler's returned promise), so without this a
 * failed save is an unhandled rejection and the user is told nothing.
 */
function persistOnBlur(q: { id?: string; key: string; answer?: string }): void {
  const block = blockId.value
  if (block) void persist(block, q).catch((error) => present(error, 'docInterview.saveFailed'))
}

/**
 * Persist every dirty draft. Snapshots the block id and the question list up front for the reason
 * above, and runs detached so it can be called from the synchronous close hook.
 */
function flushDrafts(): void {
  const block = blockId.value
  if (!block) return
  const list = questions.value
  void (async () => {
    for (const q of list) await persist(block, q)
    // The store rethrows, and this runs detached from any caller — so the failure is REPORTED here
    // rather than becoming an unhandled rejection. A close-time flush is the one path with no
    // button left on screen to have reported it.
  })().catch((error) => present(error, 'docInterview.saveFailed'))
}

/** Flush all dirty drafts, then run a window action (continue / proceed). */
async function flushThen(action: (id: string) => Promise<unknown>) {
  const block = blockId.value
  if (!block) return
  for (const q of questions.value) await persist(block, q)
  await action(block)
}

const onContinue = () => flushThen((id) => docInterview.continueInterview(id))
const onProceed = () => flushThen((id) => docInterview.proceedInterview(id))
</script>

<template>
  <ResultWindowShell
    :open="open"
    icon="i-lucide-messages-square"
    icon-class="bg-indigo-500/15 text-indigo-300"
    :title="block?.title ?? t('docInterview.title')"
    :subtitle="t('docInterview.subtitle')"
    width="3xl"
    testid="doc-interview-window"
    @close="close"
  >
    <template v-if="session" #header-extras>
      <UBadge :color="converged ? 'success' : 'primary'" variant="subtle" size="sm">
        {{ t(converged ? 'docInterview.status.done' : 'docInterview.status.awaiting') }}
      </UBadge>
    </template>

    <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <!-- No session yet -->
      <div
        v-if="!session"
        class="flex h-full flex-col items-center justify-center gap-2 text-center text-slate-400"
      >
        <UIcon name="i-lucide-messages-square" class="h-8 w-8 opacity-40" />
        <p class="text-sm">{{ t('docInterview.empty') }}</p>
      </div>

      <template v-else>
        <p class="mb-4 text-[13px] leading-relaxed text-slate-300">
          {{ t('docInterview.intro') }}
        </p>

        <!-- The run is still ahead of the interview (the researcher + outliner steps). Same
             chrome, different claim: nothing has been asked yet, so the "working on your answers"
             copy below would describe answers that do not exist. -->
        <InterviewGateNotice
          v-if="phase === 'preparing'"
          variant="working"
          :title="t('docInterview.preparing')"
          :hint="t('docInterview.preparingHint')"
          testid="doc-interview-preparing"
        />

        <!-- A pass is running: the human is waiting on the interviewer. Without this the window is
             byte-identical to the parked state and the submit reads as a no-op. -->
        <InterviewGateNotice
          v-else-if="phase === 'working'"
          variant="working"
          :title="t('docInterview.working')"
          :hint="t('docInterview.workingHint')"
          testid="doc-interview-working"
        />

        <!-- The document run stopped before the interview settled — a dead end otherwise. -->
        <InterviewGateNotice
          v-else-if="phase === 'failed'"
          variant="failed"
          :title="t('docInterview.failed')"
          :hint="t('docInterview.failedHint')"
          testid="doc-interview-failed"
        />

        <!-- Converged: show the synthesized authoring brief -->
        <div
          v-else-if="converged"
          class="rounded-lg border border-slate-800 bg-slate-950/40 p-4"
          data-testid="doc-interview-converged"
        >
          <p class="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
            {{ t('docInterview.brief') }}
          </p>
          <pre
            v-if="session.brief"
            class="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-slate-300"
            >{{ session.brief }}</pre>
          <p v-else class="text-[13px] text-slate-400">{{ t('docInterview.converged') }}</p>
        </div>

        <!-- No pending questions but not yet converged -->
        <div
          v-else-if="questions.length === 0"
          class="rounded-lg border border-slate-800 bg-slate-950/40 p-4 text-center text-[13px] text-slate-400"
        >
          {{ t('docInterview.converged') }}
        </div>

        <!-- Interview questions -->
        <ul v-else class="space-y-4">
          <li
            v-for="q in questions"
            :key="q.key"
            class="rounded-lg border border-slate-800 bg-slate-950/40 p-3"
            data-testid="doc-interview-question"
          >
            <p class="mb-2 text-[13px] font-medium text-slate-200">{{ q.question }}</p>
            <UTextarea
              v-model="drafts[q.key]"
              :rows="2"
              autoresize
              :placeholder="t('docInterview.answerPlaceholder')"
              class="w-full"
              data-testid="doc-interview-answer"
              @blur="persistOnBlur(q)"
            />
          </li>
        </ul>
      </template>
    </div>

    <!-- Action rail. Only while the run is actually parked on the human: mid-pass these would
         re-submit a question set already in flight, and the resume is a no-op once it isn't. -->
    <footer
      v-if="session && phase === 'awaiting' && questions.length > 0"
      class="flex items-center justify-between gap-3 border-t border-slate-800 px-5 py-3"
    >
      <p class="text-[11px] text-slate-500">
        <span
          v-if="unanswered > 0"
          class="text-amber-400/90"
          data-testid="doc-interview-unanswered"
        >
          {{ t('docInterview.unanswered', { count: unanswered }) }}
        </span>
        <span v-else>{{ t('docInterview.hint') }}</span>
      </p>
      <div class="flex items-center gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          :loading="resuming"
          :disabled="!access.canExecuteRuns.value"
          :title="
            access.canExecuteRuns.value ? t('docInterview.proceedTitle') : t('access.noRunExecute')
          "
          data-testid="doc-interview-proceed"
          @click="onProceed"
        >
          {{ t('docInterview.proceed') }}
        </UButton>
        <UButton
          color="primary"
          size="sm"
          :loading="resuming"
          :disabled="!!continueBlockedReason"
          :title="continueBlockedReason ?? t('docInterview.continueTitle')"
          data-testid="doc-interview-continue"
          @click="onContinue"
        >
          {{ t('docInterview.continue') }}
        </UButton>
      </div>
    </footer>
  </ResultWindowShell>
</template>
