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
import ResultWindowShell from '~/components/panels/ResultWindowShell.vue'

const board = useBoardStore()
const docInterview = useDocInterviewStore()
const { t } = useI18n()
const access = useWorkspaceAccess()

const { open, blockId, close } = useResultView('doc-interview', {
  onOpen: ({ blockId }) => void docInterview.load(blockId),
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
          :disabled="!access.canExecuteRuns.value"
          :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
          data-testid="doc-interview-proceed"
          @click="onProceed"
        >
          {{ t('docInterview.proceed') }}
        </UButton>
        <UButton
          color="primary"
          size="sm"
          :loading="resuming"
          :disabled="!allAnswered || !access.canExecuteRuns.value"
          :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
          data-testid="doc-interview-continue"
          @click="onContinue"
        >
          {{ t('docInterview.continue') }}
        </UButton>
      </div>
    </footer>
  </ResultWindowShell>
</template>
