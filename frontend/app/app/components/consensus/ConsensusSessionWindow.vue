<script setup lang="ts">
// Consensus session window — the dedicated, read-only surface for any step that ran the
// multi-model consensus mechanism (specialist panel / debate / ranked voting). Opened via
// the universal result-view host (routed in `ui.dispatchStepView` when a step's
// `consensus.enabled`). Visualizes the process for observability: the participants + their
// models, the round-by-round contributions (anonymized as the models saw each other),
// per-candidate votes/scores, and the synthesized result + confidence/dissent. Updates live
// as `consensus` stream events arrive.
import { computed } from 'vue'
import type { ConsensusContribution, ConsensusSession } from '~/types/consensus'

const board = useBoardStore()
const consensus = useConsensusStore()

const { open, blockId, close } = useResultView('consensus-session', {
  onOpen: (id) => {
    void consensus.load(id)
  },
})

const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const session = computed<ConsensusSession | null>(() =>
  blockId.value ? consensus.sessionFor(blockId.value) : null,
)
const loading = computed(() => (blockId.value ? consensus.isLoading(blockId.value) : false))

const STRATEGY_LABEL: Record<string, string> = {
  'specialist-panel': 'Specialist panel',
  debate: 'Debate',
  'ranked-voting': 'Ranked voting',
}
const ROUND_LABEL: Record<string, string> = {
  draft: 'Independent drafts',
  critique: 'Critique & revision',
  score: 'Scoring',
}

const STATUS_META: Record<string, { label: string; class: string }> = {
  running: { label: 'Running', class: 'bg-sky-500/15 text-sky-300' },
  synthesizing: { label: 'Synthesizing', class: 'bg-indigo-500/15 text-indigo-300' },
  done: { label: 'Done', class: 'bg-emerald-500/15 text-emerald-300' },
  failed: { label: 'Failed', class: 'bg-rose-500/15 text-rose-300' },
}

/** Anonymous label (Expert A/B/…) for a participant, matching the backend's ordering. */
function anonLabel(participantId: string): string {
  const idx = session.value?.participants.findIndex((p) => p.id === participantId) ?? -1
  return `Expert ${String.fromCharCode(65 + (idx < 0 ? 0 : idx % 26))}`
}

function roleFor(participantId: string): string {
  return session.value?.participants.find((p) => p.id === participantId)?.role ?? 'Participant'
}

function pct(n: number | null | undefined): string {
  return n == null ? '—' : `${Math.round(n * 100)}%`
}

function topScore(c: ConsensusContribution): { label: string; value: number } | null {
  if (!c.scores?.length) return null
  const best = [...c.scores].sort((a, b) => b.value - a.value)[0]!
  return { label: best.dimension, value: best.value }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex max-h-[100dvh] items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
      @click.self="close"
    >
      <div
        class="flex max-h-[90dvh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl"
      >
        <!-- header -->
        <header class="flex items-center gap-3 border-b border-slate-800 px-6 py-4">
          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15">
            <UIcon name="i-lucide-users-round" class="h-5 w-5 text-amber-300" />
          </div>
          <div class="min-w-0 flex-1">
            <h2 class="truncate text-sm font-semibold text-slate-100">
              Consensus ·
              {{ session ? (STRATEGY_LABEL[session.strategy] ?? session.strategy) : '' }}
              <span v-if="block" class="font-normal text-slate-400">— {{ block.title }}</span>
            </h2>
            <p v-if="session" class="text-xs text-slate-500">
              {{ session.agentKind }} · {{ session.participants.length }} participants
            </p>
          </div>
          <span
            v-if="session"
            class="rounded-full px-2.5 py-1 text-xs font-medium"
            :class="STATUS_META[session.status]?.class ?? 'bg-slate-700 text-slate-300'"
          >
            {{ STATUS_META[session.status]?.label ?? session.status }}
          </span>
          <button
            class="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            @click="close"
          >
            <UIcon name="i-lucide-x" class="h-5 w-5" />
          </button>
        </header>

        <div class="flex-1 overflow-y-auto px-6 py-5">
          <div v-if="loading && !session" class="py-16 text-center text-sm text-slate-500">
            Loading consensus session…
          </div>
          <div v-else-if="!session" class="py-16 text-center text-sm text-slate-500">
            No consensus session has run for this step yet.
          </div>
          <template v-else>
            <!-- failure -->
            <div
              v-if="session.status === 'failed'"
              class="mb-5 rounded-lg border border-rose-800/60 bg-rose-950/40 px-4 py-3 text-sm text-rose-200"
            >
              Consensus failed: {{ session.error ?? 'unknown error' }}
            </div>

            <!-- synthesized result -->
            <section v-if="session.synthesis" class="mb-6">
              <div class="mb-2 flex items-center gap-2">
                <h3 class="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Synthesized result
                </h3>
                <span
                  v-if="session.confidence != null"
                  class="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-300"
                  >confidence {{ pct(session.confidence) }}</span
                >
              </div>
              <pre
                class="whitespace-pre-wrap rounded-lg border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm text-slate-200"
                >{{ session.synthesis }}</pre
              >
              <ul v-if="session.dissent?.length" class="mt-2 space-y-1">
                <li
                  v-for="(d, i) in session.dissent"
                  :key="i"
                  class="flex items-start gap-2 text-xs text-amber-300/90"
                >
                  <UIcon name="i-lucide-triangle-alert" class="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{{ d }}</span>
                </li>
              </ul>
            </section>

            <!-- participants -->
            <section class="mb-6">
              <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Panel
              </h3>
              <div class="flex flex-wrap gap-2">
                <div
                  v-for="(p, i) in session.participants"
                  :key="p.id"
                  class="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-1.5 text-xs"
                >
                  <span class="font-medium text-slate-200"
                    >Expert {{ String.fromCharCode(65 + i) }}</span
                  >
                  <span class="text-slate-400"> · {{ p.role }}</span>
                  <span v-if="p.modelId" class="ml-1 text-slate-500">({{ p.modelId }})</span>
                </div>
              </div>
            </section>

            <!-- rounds -->
            <section v-for="round in session.rounds" :key="round.index" class="mb-5">
              <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Round {{ round.index + 1 }} ·
                {{ round.kind ? (ROUND_LABEL[round.kind] ?? round.kind) : 'Contributions' }}
              </h3>
              <div class="space-y-3">
                <div
                  v-for="c in round.contributions"
                  :key="c.participantId"
                  class="rounded-lg border border-slate-800 bg-slate-950/40 px-4 py-3"
                >
                  <div class="mb-1 flex items-center gap-2">
                    <span class="text-xs font-semibold text-slate-200">{{
                      anonLabel(c.participantId)
                    }}</span>
                    <span class="text-xs text-slate-500">{{ roleFor(c.participantId) }}</span>
                    <span
                      v-if="topScore(c)"
                      class="ml-auto rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300"
                      >top {{ topScore(c)!.label }} {{ pct(topScore(c)!.value) }}</span
                    >
                  </div>
                  <pre class="whitespace-pre-wrap text-sm text-slate-300">{{ c.text }}</pre>
                  <div v-if="c.scores?.length" class="mt-2 flex flex-wrap gap-1.5">
                    <span
                      v-for="s in c.scores"
                      :key="s.dimension"
                      class="rounded bg-slate-800/80 px-1.5 py-0.5 text-xs text-slate-400"
                      >{{ s.dimension }}: {{ pct(s.value) }}</span
                    >
                  </div>
                </div>
              </div>
            </section>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>
