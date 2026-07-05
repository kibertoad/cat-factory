<script setup lang="ts">
// The interactive document-interview window (WS5) — the dedicated view of the doc-authoring
// INTERVIEWER gate. While the document run is parked between the outline and the draft, the
// interviewer's clarifying questions (pending `qa` entries with an empty answer) are shown here;
// the human answers them, then either CONTINUES (the interviewer re-runs and may ask follow-ups)
// or PROCEEDS (skip remaining questions — the interviewer converges into an authoring brief and
// the run advances to the writer). Opened via the universal result-view host as the
// `doc-interviewer` step's result view. Live `docInterview` stream events patch the store, so an
// open window follows the interview as it progresses. Mirrors InitiativePlanningWindow.vue.
import { computed, reactive, watch } from 'vue'

const board = useBoardStore()
const docInterview = useDocInterviewStore()
const { t } = useI18n()

const { open, blockId, close } = useResultView('doc-interview', {
  onOpen: (id) => void docInterview.load(id),
})

const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const session = computed(() => (blockId.value ? docInterview.forBlock(blockId.value) : null))

/** Every interview exchange, with a stable key for the list + draft map. */
const questions = computed(() =>
  (session.value?.qa ?? []).map((q, i) => ({ ...q, key: q.id ?? `q-${i}` })),
)
const pending = computed(() => questions.value.filter((q) => !(q.answer ?? '').trim()))
/** The interview converged (or never started with a model): nothing left to answer. */
const converged = computed(() => session.value?.status === 'done')

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
/** Continue is meaningful once every pending question has a drafted answer. */
const allAnswered = computed(() => pending.value.every((q) => drafts[q.key]?.trim()))

/** Persist one answer if its draft differs from what's recorded. */
async function persist(q: { id?: string; key: string; answer?: string }) {
  const id = q.id
  if (!id || !blockId.value) return
  const next = (drafts[q.key] ?? '').trim()
  if (!next || next === (q.answer ?? '').trim()) return
  await docInterview.answerQuestion(blockId.value, id, next)
}

/** Flush all dirty drafts, then run a window action (continue / proceed). */
async function flushThen(action: (id: string) => Promise<unknown>) {
  if (!blockId.value) return
  for (const q of questions.value) await persist(q)
  await action(blockId.value)
}

const onContinue = () => flushThen((id) => docInterview.continueInterview(id))
const onProceed = () => flushThen((id) => docInterview.proceedInterview(id))
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
        data-testid="doc-interview-window"
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
              {{ block?.title ?? t('docInterview.title') }}
            </h2>
            <p class="truncate text-[11px] text-slate-400">
              {{ t('docInterview.subtitle') }}
            </p>
          </div>
          <UBadge
            v-if="session"
            :color="converged ? 'success' : 'primary'"
            variant="subtle"
            size="sm"
          >
            {{ t(converged ? 'docInterview.status.done' : 'docInterview.status.awaiting') }}
          </UBadge>
          <button
            class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            @click="close"
          >
            <UIcon name="i-lucide-x" class="h-4 w-4" />
          </button>
        </header>

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

            <!-- Converged: show the synthesized authoring brief -->
            <div
              v-if="converged"
              class="rounded-lg border border-slate-800 bg-slate-950/40 p-4"
              data-testid="doc-interview-converged"
            >
              <p class="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                {{ t('docInterview.brief') }}
              </p>
              <pre
                v-if="session.brief"
                class="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-slate-300"
                >{{ session.brief }}</pre
              >
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
                  @blur="persist(q)"
                />
              </li>
            </ul>
          </template>
        </div>

        <!-- Action rail -->
        <footer
          v-if="session && !converged && questions.length > 0"
          class="flex items-center justify-between gap-3 border-t border-slate-800 px-5 py-3"
        >
          <p class="text-[11px] text-slate-500">
            {{ t('docInterview.hint') }}
          </p>
          <div class="flex items-center gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              :loading="resuming"
              data-testid="doc-interview-proceed"
              @click="onProceed"
            >
              {{ t('docInterview.proceed') }}
            </UButton>
            <UButton
              color="primary"
              size="sm"
              :loading="resuming"
              :disabled="!allAnswered"
              data-testid="doc-interview-continue"
              @click="onContinue"
            >
              {{ t('docInterview.continue') }}
            </UButton>
          </div>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
