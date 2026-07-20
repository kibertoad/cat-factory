<script setup lang="ts">
// Implementation-fork decision window — the dedicated surface for the read-only proposer's
// materially different implementation approaches, opened via the universal result-view host
// (`ui.openForkDecision`). It reads the live fork state straight off the run's Coder step
// (`step.forkDecision`, kept fresh by the execution stream) and lets a human pick a proposed
// fork OR enter their own free-text approach, or CHAT about the forks before deciding. Once
// chosen, the Coder re-runs with the chosen approach folded in. Chat replies are computed by an
// inline grounded LLM in the durable driver and arrive live on the execution stream.
import { computed, ref, watch } from 'vue'
import { DEFAULT_FORK_MAX_CHAT_TURNS } from '@cat-factory/contracts'
import { useResultView } from '~/composables/useResultView'
import { useExecutionStore } from '~/stores/execution'
import { useBoardStore } from '~/stores/board'
import { useForkDecisionStore } from '~/stores/forkDecision'
import type { ForkChatMessage, ForkDecisionStepState, ForkOption } from '~/types/execution'
import { FORK_DECISION_META } from '~/utils/catalog'
import ResultWindowShell from '~/components/panels/ResultWindowShell.vue'

const execution = useExecutionStore()
const board = useBoardStore()
const forkDecision = useForkDecisionStore()
const access = useWorkspaceAccess()

const { t } = useI18n()

// Hybrid: state rides the coder step (like follow-ups), but warm it from the GET on open too.
// No `stepRef`: this is a pre-run decision, so there's no "restart from here".
const { open, blockId, instanceId, stepIndex, close } = useResultView('fork-decision', {
  onOpen: ({ blockId }) => void forkDecision.load(blockId),
})

const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const headerTitle = computed(() =>
  block.value
    ? t('forkDecision.titleWithBlock', { title: block.value.title })
    : t('forkDecision.title'),
)
const instance = computed(() =>
  instanceId.value === null ? null : (execution.getInstance(instanceId.value) ?? null),
)
const step = computed(() => {
  if (instance.value === null || stepIndex.value === null) return null
  return instance.value.steps[stepIndex.value] ?? null
})
const state = computed<ForkDecisionStepState | null>(() => step.value?.forkDecision ?? null)
const status = computed(() => state.value?.status ?? null)
const forks = computed<ForkOption[]>(() => state.value?.forks ?? [])
const awaiting = computed(() => status.value === 'awaiting_choice')
// A chat turn is being answered by the inline responder (the reply arrives via the stream).
const answering = computed(() => status.value === 'answering')
// The interactive surface (fork cards + chat + choose) is shown while awaiting OR answering.
const interactive = computed(() => awaiting.value || answering.value)
const chat = computed<ForkChatMessage[]>(() => state.value?.chat ?? [])
// The chat has spent its human-turn budget once the human has sent `maxChatTurns` messages.
const chatBudgetSpent = computed(() => {
  const max = state.value?.maxChatTurns ?? DEFAULT_FORK_MAX_CHAT_TURNS
  return chat.value.filter((m) => m.role === 'human').length >= max
})
// `awaiting` and `answering` are mutually exclusive statuses, so awaiting already implies the
// chat isn't mid-answer — no separate `!answering` guard is needed.
const canChat = computed(() => awaiting.value && !chatBudgetSpent.value && !forkDecision.chatting)

// The human's selection: a proposed fork id, or the sentinel 'custom' for the free-text path.
const selected = ref<string | null>(null)
const customText = ref('')
const note = ref('')
const chatInput = ref('')

// Default the selection to the recommended fork whenever the fork set changes.
watch(
  forks,
  (list) => {
    if (
      selected.value &&
      (selected.value === 'custom' || list.some((f) => f.id === selected.value))
    )
      return
    selected.value = list.find((f) => f.recommended)?.id ?? list[0]?.id ?? null
  },
  { immediate: true },
)

const canChoose = computed(() => {
  if (!awaiting.value || forkDecision.choosing) return false
  if (selected.value === 'custom') return customText.value.trim().length > 0
  return selected.value != null
})

async function onChoose() {
  const id = instanceId.value
  if (!id || !canChoose.value) return
  const noteText = note.value.trim() || undefined
  const choice =
    selected.value === 'custom'
      ? { custom: customText.value.trim(), note: noteText }
      : { forkId: selected.value!, note: noteText }
  await forkDecision.choose(id, choice).catch(() => {})
}

async function onSend() {
  const id = instanceId.value
  const text = chatInput.value.trim()
  if (!id || !text || !canChat.value) return
  chatInput.value = ''
  await forkDecision.chat(id, text).catch(() => {})
}
</script>

<template>
  <ResultWindowShell
    :open="open"
    :icon="FORK_DECISION_META.icon"
    icon-class="bg-violet-500/15 text-violet-300"
    :title="headerTitle"
    :subtitle="t('forkDecision.subtitle')"
    width="3xl"
    testid="fork-decision-window"
    @close="close"
  >
    <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <!-- Proposing: the read-only proposer is still working. -->
      <div
        v-if="status === 'proposing'"
        class="flex h-full flex-col items-center justify-center gap-2 py-10 text-center text-slate-400"
      >
        <UIcon name="i-lucide-loader-circle" class="h-8 w-8 animate-spin opacity-60" />
        <p class="text-sm">{{ t('forkDecision.proposing.title') }}</p>
        <p class="max-w-sm text-[11px] text-slate-500">
          {{ t('forkDecision.proposing.hint') }}
        </p>
      </div>

      <!-- A single path (no materially different alternatives): a read-only record. -->
      <div
        v-else-if="status === 'single_path'"
        class="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-slate-300"
      >
        <p class="text-[13px] font-medium text-slate-100">
          {{ t('forkDecision.singlePath.title') }}
        </p>
        <p v-if="state?.singlePathReason" class="mt-1 text-[12px]">
          {{ state.singlePathReason }}
        </p>
      </div>

      <!-- Chosen: a read-only record of what was decided. -->
      <div
        v-else-if="status === 'chosen'"
        class="rounded-xl border border-violet-500/40 bg-slate-900/60 px-4 py-3 text-slate-300"
      >
        <p class="text-[13px] font-medium text-violet-200">
          {{ t('forkDecision.chosen.title') }}
        </p>
        <p v-if="state?.chosen?.custom" class="mt-1 whitespace-pre-wrap text-[12px]">
          {{ state.chosen.custom }}
        </p>
        <p v-else-if="state?.chosen?.forkId" class="mt-1 text-[12px]">
          {{ forks.find((f) => f.id === state?.chosen?.forkId)?.title }}
        </p>
        <p v-if="state?.chosen?.note" class="mt-1 text-[11px] text-slate-400">
          {{ t('forkDecision.chosen.note', { note: state.chosen.note }) }}
        </p>
      </div>

      <!-- Awaiting the human's choice (or answering a chat turn). -->
      <div v-else-if="interactive" class="space-y-3">
        <p
          v-if="forkDecision.error"
          class="rounded-md bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300"
        >
          {{ forkDecision.error }}
        </p>

        <p
          v-if="state?.seamSummary"
          class="rounded-md bg-slate-800/50 px-3 py-2 text-[12px] text-slate-300"
        >
          <span class="text-slate-500">{{ t('forkDecision.seam') }}</span>
          {{ state.seamSummary }}
        </p>

        <!-- Proposed fork cards -->
        <article
          v-for="fork in forks"
          :key="fork.id"
          data-testid="fork-option-card"
          class="cursor-pointer rounded-xl border px-4 py-3 transition"
          :class="
            selected === fork.id
              ? 'border-violet-500/70 bg-violet-500/5'
              : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
          "
          @click="selected = fork.id"
        >
          <div class="flex items-start gap-2">
            <input
              type="radio"
              class="mt-1 accent-violet-500"
              :checked="selected === fork.id"
              @change="selected = fork.id"
            />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <h3 class="min-w-0 flex-1 text-[13px] font-medium text-slate-100">
                  {{ fork.title }}
                </h3>
                <UBadge v-if="fork.recommended" color="primary" variant="subtle" size="sm">
                  {{ t('forkDecision.recommended') }}
                </UBadge>
              </div>
              <p v-if="fork.summary" class="mt-0.5 text-[12px] text-slate-400">
                {{ fork.summary }}
              </p>
              <p class="mt-1.5 whitespace-pre-wrap text-[12px] text-slate-300">
                {{ fork.approach }}
              </p>
              <ul v-if="fork.tradeoffs.length" class="mt-1.5 space-y-0.5">
                <li
                  v-for="(tr, i) in fork.tradeoffs"
                  :key="i"
                  class="flex gap-1.5 text-[11px] text-slate-400"
                >
                  <span class="text-slate-600">•</span>{{ tr }}
                </li>
              </ul>
              <p v-if="fork.riskNotes" class="mt-1.5 text-[11px] text-amber-300/90">
                <span class="text-amber-500/70">{{ t('forkDecision.riskNotes') }}</span>
                {{ fork.riskNotes }}
              </p>
            </div>
          </div>
        </article>

        <!-- Custom approach -->
        <article
          class="rounded-xl border px-4 py-3 transition"
          :class="
            selected === 'custom'
              ? 'border-violet-500/70 bg-violet-500/5'
              : 'border-slate-800 bg-slate-900/60'
          "
        >
          <label class="flex cursor-pointer items-center gap-2" @click="selected = 'custom'">
            <input type="radio" class="accent-violet-500" :checked="selected === 'custom'" />
            <span class="text-[13px] font-medium text-slate-100">{{
              t('forkDecision.custom.title')
            }}</span>
          </label>
          <textarea
            v-model="customText"
            data-testid="fork-custom-input"
            rows="3"
            :placeholder="t('forkDecision.custom.placeholder')"
            class="mt-2 w-full resize-y rounded-md border border-slate-700 bg-slate-950/60 px-2.5 py-1.5 text-[12px] text-slate-100 placeholder:text-slate-600 focus:border-violet-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
            @focus="selected = 'custom'"
          />
        </article>

        <!-- Optional steering note -->
        <div>
          <label class="mb-1 block text-[11px] text-slate-400">{{
            t('forkDecision.noteLabel')
          }}</label>
          <input
            v-model="note"
            type="text"
            :placeholder="t('forkDecision.notePlaceholder')"
            class="w-full rounded-md border border-slate-700 bg-slate-950/60 px-2.5 py-1.5 text-[12px] text-slate-100 placeholder:text-slate-600 focus:border-violet-500 focus:outline-none"
          />
        </div>

        <!-- Grounded chat: ask about the forks before deciding. -->
        <section class="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3">
          <p class="text-[11px] font-medium text-slate-400">
            {{ t('forkDecision.chat.title') }}
          </p>
          <div v-if="chat.length || answering" class="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1">
            <div
              v-for="msg in chat"
              :key="msg.id"
              data-testid="fork-chat-message"
              class="flex"
              :class="msg.role === 'human' ? 'justify-end' : 'justify-start'"
            >
              <p
                class="max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-1.5 text-[12px]"
                :class="
                  msg.role === 'human'
                    ? 'bg-violet-500/15 text-violet-100'
                    : 'bg-slate-800/70 text-slate-200'
                "
              >
                {{ msg.text }}
              </p>
            </div>
            <div v-if="answering" class="flex justify-start">
              <p
                class="flex items-center gap-1.5 rounded-lg bg-slate-800/70 px-3 py-1.5 text-[12px] text-slate-400"
              >
                <UIcon name="i-lucide-loader-circle" class="h-3.5 w-3.5 animate-spin" />
                {{ t('forkDecision.chat.thinking') }}
              </p>
            </div>
          </div>
          <p v-else class="mt-1 text-[11px] text-slate-500">
            {{ t('forkDecision.chat.hint') }}
          </p>
          <div class="mt-2 flex items-end gap-2">
            <textarea
              v-model="chatInput"
              data-testid="fork-chat-input"
              rows="2"
              :disabled="!canChat"
              :placeholder="
                chatBudgetSpent
                  ? t('forkDecision.chat.budgetSpent')
                  : t('forkDecision.chat.placeholder')
              "
              class="min-h-0 flex-1 resize-y rounded-md border border-slate-700 bg-slate-950/60 px-2.5 py-1.5 text-[12px] text-slate-100 placeholder:text-slate-600 focus:border-violet-500 focus:outline-none disabled:opacity-50"
              @keydown.enter.exact.prevent="onSend"
            />
            <UButton
              data-testid="fork-chat-send"
              color="neutral"
              variant="soft"
              size="sm"
              icon="i-lucide-send"
              :loading="forkDecision.chatting"
              :disabled="!canChat || chatInput.trim().length === 0 || !access.canExecuteRuns.value"
              :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
              @click="onSend"
            >
              {{ t('forkDecision.chat.send') }}
            </UButton>
          </div>
        </section>
      </div>

      <!-- Skipped / no state: nothing to decide. -->
      <div
        v-else
        class="flex h-full flex-col items-center justify-center gap-2 py-10 text-center text-slate-400"
      >
        <UIcon :name="FORK_DECISION_META.icon" class="h-8 w-8 opacity-40" />
        <p class="text-sm">{{ t('forkDecision.empty.title') }}</p>
      </div>
    </div>

    <footer
      v-if="interactive"
      class="flex items-center justify-end gap-2 border-t border-slate-800 px-5 py-3"
    >
      <UButton color="neutral" variant="ghost" size="sm" @click="close">
        {{ t('common.cancel') }}
      </UButton>
      <UButton
        data-testid="fork-option-choose"
        color="primary"
        size="sm"
        icon="i-lucide-check"
        :loading="forkDecision.choosing"
        :disabled="!canChoose || !access.canExecuteRuns.value"
        :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
        @click="onChoose"
      >
        {{ t('forkDecision.choose') }}
      </UButton>
    </footer>
  </ResultWindowShell>
</template>
