<script setup lang="ts">
// The interactive-planning Q&A window (slice 2) — the dedicated view of the initiative
// INTERVIEWER gate. While the planning run is parked, the interviewer's clarifying questions
// (pending `qa` entries with an empty answer) are shown here; the human answers them, then
// either CONTINUES (the interviewer re-runs and may ask follow-ups) or PROCEEDS (skip
// remaining questions — the interviewer converges and the run advances to the analyst/planner).
// Opened via the universal result-view host: from the inspector / card
// (`ui.openInitiativePlanning`) or as the interviewer step's result view. Live `initiative`
// stream events patch the store, so an open window follows the interview as it progresses.
import { computed, reactive, watch } from 'vue'
import ClarificationItem from '~/components/common/ClarificationItem.vue'
import { INITIATIVE_STATUS_LABEL_KEYS } from '~/utils/initiative'

const board = useBoardStore()
const initiatives = useInitiativesStore()
const { t } = useI18n()

const { open, blockId, close } = useResultView('initiative-planning', {
  onOpen: (id) => void initiatives.load(id),
})

const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const initiative = computed(() => (blockId.value ? initiatives.forBlock(blockId.value) : null))

/** Every interview exchange, with a stable key for the list + draft map. */
const questions = computed(() =>
  (initiative.value?.qa ?? []).map((q, i) => ({ ...q, key: q.id ?? `q-${i}` })),
)
/** Questions still needing an answer: not dismissed, and not yet answered (mirrors backend). */
const pending = computed(() =>
  questions.value.filter((q) => q.status !== 'dismissed' && !(q.answer ?? '').trim()),
)
/** The interview converged (or never started with a model): nothing left to answer. */
const converged = computed(() => initiative.value?.interview?.status === 'done')

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
 * Continue is meaningful once every pending question has a drafted answer. A dismissed question
 * doesn't count (it was set aside), so an all-dismissed round is trivially "answered".
 */
const allAnswered = computed(() => pending.value.every((q) => drafts[q.key]?.trim()))

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
        data-testid="initiative-planning-window"
      >
        <!-- Header -->
        <header class="flex items-center gap-3 border-b border-slate-800 px-5 py-3">
          <span
            class="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-300"
          >
            <UIcon name="i-lucide-messages-square" class="h-4 w-4" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="truncate text-sm font-semibold text-slate-100">
              {{ initiative?.title ?? block?.title ?? t('initiative.planning.title') }}
            </h2>
            <p class="truncate text-[11px] text-slate-400">
              {{ t('initiative.planning.subtitle') }}
            </p>
          </div>
          <UBadge v-if="initiative" color="primary" variant="subtle" size="sm">
            {{ t(INITIATIVE_STATUS_LABEL_KEYS[initiative.status]) }}
          </UBadge>
          <button
            class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            @click="close"
          >
            <UIcon name="i-lucide-x" class="h-4 w-4" />
          </button>
        </header>

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

            <!-- Converged / no pending questions -->
            <div
              v-if="converged || questions.length === 0"
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

        <!-- Action rail -->
        <footer
          v-if="initiative && !converged && questions.length > 0"
          class="flex items-center justify-between gap-3 border-t border-slate-800 px-5 py-3"
        >
          <p class="text-[11px] text-slate-500">
            {{ t('initiative.planning.hint') }}
          </p>
          <div class="flex items-center gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              :loading="resuming"
              data-testid="initiative-planning-proceed"
              @click="onProceed"
            >
              {{ t('initiative.planning.proceed') }}
            </UButton>
            <UButton
              color="primary"
              size="sm"
              :loading="resuming"
              :disabled="!allAnswered"
              data-testid="initiative-planning-continue"
              @click="onContinue"
            >
              {{ t('initiative.planning.continue') }}
            </UButton>
          </div>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
