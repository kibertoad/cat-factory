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
import CopyButton from '~/components/common/CopyButton.vue'
import MarkdownProse from '~/components/common/MarkdownProse.vue'
import ResultWindowShell from '~/components/panels/ResultWindowShell.vue'
import { agentKindMeta } from '~/utils/catalog'

const { t, n } = useI18n()

const board = useBoardStore()
const consensus = useConsensusStore()
const models = useModelsStore()

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

// Composed header: "Consensus · <strategy>" as the dialog title (with the block appended when
// present), and the agent kind + participant count as the subtitle line.
const headerTitle = computed(() => {
  const base = session.value
    ? `${t('consensus.titlePrefix')} · ${strategyLabel(session.value.strategy)}`
    : t('consensus.titlePrefix')
  return block.value ? `${base} — ${block.value.title}` : base
})
const headerSubtitle = computed(() =>
  session.value
    ? `${agentKindMeta(session.value.agentKind).label} · ${t(
        'consensus.participantCount',
        { count: session.value.participants.length },
        session.value.participants.length,
      )}`
    : undefined,
)

// Exhaustive enum→key maps (literal key strings keep the typed-key drift guard live,
// vs a runtime-built `consensus.strategy.${value}`).
const STRATEGY_LABEL_KEYS: Record<string, string> = {
  'specialist-panel': 'consensus.strategy.specialistPanel',
  debate: 'consensus.strategy.debate',
  'ranked-voting': 'consensus.strategy.rankedVoting',
}
const ROUND_LABEL_KEYS: Record<string, string> = {
  draft: 'consensus.round.draft',
  critique: 'consensus.round.critique',
  score: 'consensus.round.score',
}
const STATUS_LABEL_KEYS: Record<string, string> = {
  running: 'consensus.status.running',
  synthesizing: 'consensus.status.synthesizing',
  done: 'consensus.status.done',
  failed: 'consensus.status.failed',
}
const STATUS_CLASS: Record<string, string> = {
  running: 'bg-sky-500/15 text-sky-300',
  synthesizing: 'bg-indigo-500/15 text-indigo-300',
  done: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-rose-500/15 text-rose-300',
}

function strategyLabel(strategy: string): string {
  const key = STRATEGY_LABEL_KEYS[strategy]
  return key ? t(key) : strategy
}
function roundLabel(kind: string | null | undefined): string {
  if (!kind) return t('consensus.round.contributions')
  const key = ROUND_LABEL_KEYS[kind]
  return key ? t(key) : kind
}
function statusLabel(status: string): string {
  const key = STATUS_LABEL_KEYS[status]
  return key ? t(key) : status
}

/** Anonymous label (Expert A/B/…) for a participant, matching the backend's ordering. */
function anonLabel(participantId: string): string {
  const idx = session.value?.participants.findIndex((p) => p.id === participantId) ?? -1
  return t('consensus.expert', { letter: String.fromCharCode(65 + (idx < 0 ? 0 : idx % 26)) })
}

function roleFor(participantId: string): string {
  return (
    session.value?.participants.find((p) => p.id === participantId)?.role ??
    t('consensus.participant')
  )
}

function pct(value: number | null | undefined): string {
  return value == null ? '—' : n(value, 'percent')
}

function topScore(c: ConsensusContribution): { label: string; value: number } | null {
  if (!c.scores?.length) return null
  const best = [...c.scores].sort((a, b) => b.value - a.value)[0]!
  return { label: best.dimension, value: best.value }
}
</script>

<template>
  <ResultWindowShell
    :open="open"
    icon="i-lucide-users-round"
    icon-class="bg-amber-500/15 text-amber-300"
    :title="headerTitle"
    :subtitle="headerSubtitle"
    variant="centered"
    width="5xl"
    @close="close"
  >
    <template v-if="session" #header-extras>
      <span
        class="rounded-full px-2.5 py-1 text-xs font-medium"
        :class="STATUS_CLASS[session.status] ?? 'bg-slate-700 text-slate-300'"
      >
        {{ statusLabel(session.status) }}
      </span>
    </template>

    <div class="flex-1 overflow-y-auto px-6 py-5">
      <div v-if="loading && !session" class="py-16 text-center text-sm text-slate-500">
        {{ t('consensus.loading') }}
      </div>
      <div v-else-if="!session" class="py-16 text-center text-sm text-slate-500">
        {{ t('consensus.empty') }}
      </div>
      <template v-else>
        <!-- failure -->
        <div
          v-if="session.status === 'failed'"
          class="mb-5 flex items-start gap-2 rounded-lg border border-rose-800/60 bg-rose-950/40 px-4 py-3 text-sm text-rose-200"
        >
          <span class="min-w-0 flex-1">{{
            t('consensus.failed', { error: session.error ?? t('consensus.unknownError') })
          }}</span>
          <CopyButton v-if="session.error" :text="session.error" class="-me-1 shrink-0" />
        </div>

        <!-- synthesized result -->
        <section v-if="session.synthesis" class="mb-6">
          <div class="mb-2 flex items-center gap-2">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-slate-400">
              {{ t('consensus.synthesizedResult') }}
            </h3>
            <span
              v-if="session.confidence != null"
              class="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-300"
              >{{ t('consensus.confidence', { pct: pct(session.confidence) }) }}</span
            >
            <CopyButton :text="session.synthesis" class="ms-auto -my-1" />
          </div>
          <MarkdownProse
            :text="session.synthesis"
            class="rounded-lg border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm text-slate-200"
          />
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
            {{ t('consensus.panel') }}
          </h3>
          <div class="flex flex-wrap gap-2">
            <div
              v-for="(p, i) in session.participants"
              :key="p.id"
              class="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-1.5 text-xs"
            >
              <span class="font-medium text-slate-200">{{
                t('consensus.expert', { letter: String.fromCharCode(65 + i) })
              }}</span>
              <span class="text-slate-400"> · {{ p.role }}</span>
              <span v-if="p.modelId" class="ms-1 text-slate-500"
                >({{ models.labelForRef(p.modelId) ?? p.modelId }})</span
              >
            </div>
          </div>
        </section>

        <!-- rounds -->
        <section v-for="round in session.rounds" :key="round.index" class="mb-5">
          <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            {{ t('consensus.round.heading', { n: round.index + 1 }) }} ·
            {{ roundLabel(round.kind) }}
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
                  class="ms-auto rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300"
                  >{{
                    t('consensus.topScore', {
                      label: topScore(c)!.label,
                      pct: pct(topScore(c)!.value),
                    })
                  }}</span
                >
                <CopyButton :text="c.text" :class="topScore(c) ? '-my-1' : 'ms-auto -my-1'" />
              </div>
              <MarkdownProse :text="c.text" class="text-sm text-slate-300" />
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
  </ResultWindowShell>
</template>
