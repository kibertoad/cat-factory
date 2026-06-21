<script setup lang="ts">
// Requirements review window: the human reacts to the reviewer agent's structured
// findings about a block's collected requirements — answering the relevant ones and
// dismissing the irrelevant — then runs the "requirements rework" agent, which folds
// the answers into ONE standard-format requirements document. That reworked document
// (not the original description + linked docs/tasks) is what every subsequent agent
// step and the requirements-writer consume. Modelled on the polished markdown review
// window (AgentStepDetail.vue): a full-screen overlay with a header, a main column
// and a right action rail; the reworked result reads as collapsible markdown.
import { parseOutputOutline } from '~/utils/agentOutput'
import type {
  RequirementReview,
  RequirementReviewItem,
  ReviewItemCategory,
  ReviewItemSeverity,
  ReviewItemStatus,
} from '~/types/requirements'

const ui = useUiStore()
const board = useBoardStore()
const requirements = useRequirementsStore()
const toast = useToast()

const open = computed(() => ui.requirementReviewBlockId !== null)
const blockId = computed(() => ui.requirementReviewBlockId)
const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const review = computed<RequirementReview | null>(() =>
  blockId.value ? requirements.reviewFor(blockId.value) : null,
)
const busy = computed(() => (blockId.value ? requirements.isReviewing(blockId.value) : false))
const reworking = computed(() =>
  review.value ? requirements.isIncorporating(review.value.id) : false,
)

// Draft replies, keyed by item id, so editing one item doesn't disturb others.
const drafts = ref<Record<string, string>>({})

// Load the current review whenever the window opens for a block.
watch(blockId, (id) => {
  drafts.value = {}
  if (id) void requirements.load(id)
})

// Esc closes, matching the prose review overlay.
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) close()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

function close() {
  ui.closeRequirementReview()
}

const SEVERITY_RANK: Record<ReviewItemSeverity, number> = { high: 0, medium: 1, low: 2 }
const sortedItems = computed<RequirementReviewItem[]>(() => {
  if (!review.value) return []
  return [...review.value.items].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  )
})

const openCount = computed(() => (review.value ? requirements.openCount(review.value) : 0))
const settledCount = computed(() =>
  review.value ? review.value.items.length - openCount.value : 0,
)
const canRework = computed(() => !!review.value && requirements.canRework(review.value))
const reworked = computed(() => review.value?.status === 'incorporated')
// The quality companion's verdicts — one per rework cycle, in order. The last is the
// latest; when it REJECTED the document (passed === false) the rework was not accepted
// and its challenge is surfaced for the human to address before reworking again.
const companionVerdicts = computed(() => review.value?.companionVerdicts ?? [])
const companion = computed(() => companionVerdicts.value.at(-1) ?? null)
const companionRejected = computed(() => companion.value?.passed === false)
const pctOf = (n: number) => `${Math.round(n * 100)}%`

// The reworked requirements rendered as collapsible markdown (same reader the prose
// review window uses), shown once the rework agent has produced them.
const outline = computed(() =>
  review.value?.incorporatedRequirements
    ? parseOutputOutline(review.value.incorporatedRequirements)
    : null,
)
const collapsed = ref<Record<string, boolean>>({})
function toggle(id: string) {
  collapsed.value = { ...collapsed.value, [id]: !collapsed.value[id] }
}

const SEVERITY_COLOR: Record<ReviewItemSeverity, string> = {
  high: 'error',
  medium: 'warning',
  low: 'neutral',
}
const CATEGORY_ICON: Record<ReviewItemCategory, string> = {
  gap: 'i-lucide-puzzle',
  clarification: 'i-lucide-help-circle',
  assumption: 'i-lucide-lightbulb',
  risk: 'i-lucide-shield-alert',
  question: 'i-lucide-message-circle-question',
}
const STATUS_COLOR: Record<ReviewItemStatus, string> = {
  open: 'warning',
  answered: 'info',
  resolved: 'success',
  dismissed: 'neutral',
}

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

async function runReview() {
  if (!blockId.value) return
  try {
    const result = await requirements.review(blockId.value)
    toast.add({
      title: result.items.length
        ? `${result.items.length} finding(s) to react to`
        : 'No gaps found — requirements look complete',
      icon: 'i-lucide-sparkles',
    })
  } catch (e) {
    notifyError('Could not run the requirements review', e)
  }
}

async function submitReply(item: RequirementReviewItem) {
  if (!review.value) return
  const text = (drafts.value[item.id] ?? '').trim()
  if (!text) return
  try {
    await requirements.reply(review.value, item.id, text)
    drafts.value = { ...drafts.value, [item.id]: '' }
    toast.add({ title: 'Answer saved', icon: 'i-lucide-check' })
  } catch (e) {
    notifyError('Could not save the answer', e)
  }
}

async function setStatus(item: RequirementReviewItem, status: ReviewItemStatus) {
  if (!review.value) return
  try {
    await requirements.setItemStatus(review.value, item.id, status)
  } catch (e) {
    notifyError('Could not update the finding', e)
  }
}

async function rework() {
  if (!review.value) return
  try {
    await requirements.incorporate(review.value)
    toast.add({ title: 'Requirements reworked', icon: 'i-lucide-check-check' })
  } catch (e) {
    notifyError('Could not rework the requirements', e)
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
      @click.self="close"
    >
      <div
        class="flex h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl"
      >
        <!-- header -->
        <header class="flex items-center gap-3 border-b border-slate-800 px-6 py-4">
          <div
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15"
          >
            <UIcon name="i-lucide-clipboard-check" class="h-5 w-5 text-indigo-300" />
          </div>
          <div class="min-w-0">
            <h1 class="truncate text-base font-semibold text-white">Requirements review</h1>
            <p v-if="block" class="truncate text-xs text-slate-500">{{ block.title }}</p>
          </div>
          <div class="ml-auto flex items-center gap-1.5">
            <UButton
              color="primary"
              variant="soft"
              size="sm"
              icon="i-lucide-sparkles"
              :loading="busy"
              @click="runReview"
            >
              {{ review ? 'Re-run review' : 'Run review' }}
            </UButton>
            <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="sm" @click="close" />
          </div>
        </header>

        <div class="flex min-h-0 flex-1">
          <!-- main column -->
          <div class="min-w-0 flex-1 overflow-y-auto px-6 py-5">
            <p class="mb-4 text-sm text-slate-400">
              An AI reviewer inspected this {{ block?.level ?? 'item' }}’s collected requirements —
              its description plus any linked PRDs and tracker issues — and raised the findings
              below. <span class="text-slate-300">Answer</span> the relevant ones and
              <span class="text-slate-300">dismiss</span> the irrelevant, then rework them into a
              single standard-format requirements document.
            </p>

            <!-- empty / first-run state -->
            <div
              v-if="!review && !busy"
              class="rounded-lg border border-dashed border-slate-700 p-8 text-center text-sm text-slate-500"
            >
              No review yet. Run the reviewer to surface findings about the requirements.
            </div>

            <!-- working state -->
            <div
              v-else-if="busy && !review"
              class="flex items-center justify-center gap-2 p-8 text-sm text-slate-400"
            >
              <UIcon name="i-lucide-loader-circle" class="h-4 w-4 animate-spin" />
              Reviewing the requirements…
            </div>

            <template v-else-if="review">
              <!-- no findings: requirements look complete -->
              <div
                v-if="review.items.length === 0"
                class="mb-4 flex items-center gap-2 rounded-lg border border-emerald-900/60 bg-emerald-950/30 p-4 text-sm text-emerald-300"
              >
                <UIcon name="i-lucide-circle-check" class="h-5 w-5 shrink-0" />
                The reviewer found no gaps. You can still rework the requirements into the standard
                format from the panel on the right.
              </div>

              <!-- findings to react to -->
              <div v-else class="flex flex-col gap-3">
                <div
                  v-for="item in sortedItems"
                  :key="item.id"
                  class="rounded-lg border border-slate-800 bg-slate-900/60 p-3"
                  :class="{ 'opacity-60': item.status === 'dismissed' }"
                >
                  <div class="flex items-start gap-2">
                    <UIcon
                      :name="CATEGORY_ICON[item.category]"
                      class="mt-0.5 h-4 w-4 shrink-0 text-slate-400"
                    />
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-1.5">
                        <span class="text-sm font-medium text-white">{{ item.title }}</span>
                        <UBadge
                          size="xs"
                          variant="subtle"
                          :color="SEVERITY_COLOR[item.severity] as any"
                        >
                          {{ item.severity }}
                        </UBadge>
                        <UBadge size="xs" variant="outline" color="neutral">
                          {{ item.category }}
                        </UBadge>
                        <UBadge
                          size="xs"
                          variant="soft"
                          :color="STATUS_COLOR[item.status] as any"
                          class="ml-auto"
                        >
                          {{ item.status }}
                        </UBadge>
                      </div>
                      <p class="mt-1 whitespace-pre-line text-sm text-slate-400">
                        {{ item.detail }}
                      </p>

                      <!-- recorded answer -->
                      <div
                        v-if="item.reply"
                        class="mt-2 rounded-md border-l-2 border-slate-700 bg-slate-950/40 px-3 py-1.5 text-sm text-slate-300"
                      >
                        <span class="text-[10px] uppercase tracking-wide text-slate-500">
                          Answer
                        </span>
                        <p class="whitespace-pre-line">{{ item.reply }}</p>
                      </div>

                      <!-- react: answer (relevant) or dismiss (irrelevant) -->
                      <template v-if="item.status !== 'resolved' && item.status !== 'dismissed'">
                        <UTextarea
                          v-model="drafts[item.id]"
                          :rows="2"
                          autoresize
                          size="sm"
                          class="mt-2 w-full"
                          :placeholder="item.reply ? 'Refine your answer…' : 'Answer this finding…'"
                        />
                        <div class="mt-2 flex flex-wrap items-center gap-2">
                          <UButton
                            color="primary"
                            variant="soft"
                            size="xs"
                            icon="i-lucide-corner-down-left"
                            :disabled="!(drafts[item.id] ?? '').trim()"
                            @click="submitReply(item)"
                          >
                            Save answer
                          </UButton>
                          <UButton
                            color="success"
                            variant="ghost"
                            size="xs"
                            icon="i-lucide-check"
                            @click="setStatus(item, 'resolved')"
                          >
                            Resolve
                          </UButton>
                          <UButton
                            color="neutral"
                            variant="ghost"
                            size="xs"
                            icon="i-lucide-x"
                            @click="setStatus(item, 'dismissed')"
                          >
                            Dismiss as irrelevant
                          </UButton>
                        </div>
                      </template>

                      <!-- reopen a settled finding -->
                      <div v-else class="mt-2">
                        <UButton
                          color="neutral"
                          variant="ghost"
                          size="xs"
                          icon="i-lucide-rotate-ccw"
                          @click="setStatus(item, item.reply ? 'answered' : 'open')"
                        >
                          Reopen
                        </UButton>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- companion verdict on the last rework -->
              <section
                v-if="companion"
                class="mt-6 rounded-lg border p-3"
                :class="
                  companionRejected
                    ? 'border-amber-500/40 bg-amber-500/5'
                    : 'border-emerald-500/30 bg-emerald-500/5'
                "
              >
                <div
                  class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide"
                  :class="companionRejected ? 'text-amber-400' : 'text-emerald-400'"
                >
                  <UIcon
                    :name="companionRejected ? 'i-lucide-shield-alert' : 'i-lucide-shield-check'"
                    class="h-3.5 w-3.5"
                  />
                  <span>
                    Quality companion · {{ pctOf(companion.rating) }}
                    {{ companionRejected ? '<' : '≥' }} {{ pctOf(companion.threshold) }}
                  </span>
                </div>
                <p
                  v-if="companionRejected"
                  class="mt-2 whitespace-pre-line text-[12px] leading-relaxed text-amber-200/90"
                >
                  {{ companion.feedback }}
                </p>
                <p v-if="companionRejected" class="mt-2 text-[11px] text-slate-400">
                  The reworked requirements were not accepted. Address the points above (answer or
                  refine the findings), then re-run the rework — the companion's feedback is fed
                  back into it.
                </p>
                <p v-else class="mt-1 text-[11px] text-slate-400">
                  The reworked requirements cleared the quality bar and now feed every downstream
                  agent step.
                </p>

                <!-- full correction sequence: every rework cycle's verdict, in order -->
                <div
                  v-if="companionVerdicts.length > 1"
                  class="mt-3 border-t border-slate-800/60 pt-2"
                >
                  <div
                    class="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500"
                  >
                    Correction history · {{ companionVerdicts.length }} iteration(s)
                  </div>
                  <ol class="space-y-1.5">
                    <li
                      v-for="(v, i) in companionVerdicts"
                      :key="i"
                      class="flex items-start gap-2 text-[11px]"
                    >
                      <span
                        class="mt-px inline-flex h-4 shrink-0 items-center rounded px-1 font-mono tabular-nums"
                        :class="
                          v.passed
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : 'bg-amber-500/15 text-amber-300'
                        "
                      >
                        {{ i + 1 }}
                      </span>
                      <div class="min-w-0">
                        <span :class="v.passed ? 'text-emerald-300' : 'text-amber-300'">
                          {{ pctOf(v.rating) }} {{ v.passed ? '≥' : '<' }} {{ pctOf(v.threshold) }}
                        </span>
                        <span v-if="v.feedback" class="ml-1 text-slate-400"
                          >— {{ v.feedback }}</span
                        >
                      </div>
                    </li>
                  </ol>
                </div>
              </section>

              <!-- reworked result: the standard-format requirements document -->
              <section v-if="outline" class="mt-6 border-t border-slate-800 pt-5">
                <div class="mb-3 flex items-center gap-1.5 text-[11px] text-emerald-400">
                  <UIcon name="i-lucide-file-check-2" class="h-3.5 w-3.5" />
                  <span class="font-semibold uppercase tracking-wide">Reworked requirements</span>
                </div>
                <div v-for="s in outline.sections" :key="s.id" class="mb-2">
                  <button
                    v-if="s.title"
                    class="group flex w-full items-center gap-2 text-left"
                    @click="toggle(s.id)"
                  >
                    <UIcon
                      name="i-lucide-chevron-right"
                      class="h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform"
                      :class="collapsed[s.id] ? '' : 'rotate-90'"
                    />
                    <span
                      class="font-semibold text-white"
                      :class="s.depth <= 1 ? 'text-base' : s.depth === 2 ? 'text-sm' : 'text-xs'"
                      v-html="s.titleHtml"
                    />
                  </button>
                  <div
                    v-show="!s.title || !collapsed[s.id]"
                    class="reader-prose mt-1 pl-5.5 text-[13px] leading-relaxed text-slate-300"
                    v-html="s.bodyHtml"
                  />
                </div>
              </section>
            </template>
          </div>

          <!-- right action rail -->
          <aside class="hidden w-72 shrink-0 flex-col border-l border-slate-800 lg:flex">
            <div class="flex flex-col gap-4 px-4 py-5">
              <div v-if="review" class="space-y-2 text-xs text-slate-400">
                <div class="flex items-center justify-between">
                  <span>Findings</span>
                  <span class="text-slate-300">{{ review.items.length }}</span>
                </div>
                <div class="flex items-center justify-between">
                  <span>Reacted</span>
                  <span class="text-slate-300">{{ settledCount }} / {{ review.items.length }}</span>
                </div>
                <div v-if="review.model" class="flex items-center justify-between">
                  <span>Model</span>
                  <span class="truncate pl-2 text-slate-500">{{ review.model }}</span>
                </div>
              </div>

              <div v-if="review" class="border-t border-slate-800 pt-4">
                <UButton
                  color="primary"
                  size="sm"
                  block
                  icon="i-lucide-wand-sparkles"
                  :loading="reworking"
                  :disabled="!canRework"
                  @click="rework"
                >
                  {{ reworked || companionRejected ? 'Re-run rework' : 'Rework requirements' }}
                </UButton>
                <p class="mt-2 text-[11px] leading-relaxed text-slate-500">
                  <template v-if="reworked">
                    Folded into a standard-format document. Subsequent agent steps use it instead of
                    the original description and linked docs/tasks.
                  </template>
                  <template v-else-if="canRework">
                    Sends the requirements + your answers to the rework agent, which produces one
                    standard-format document.
                  </template>
                  <template v-else>
                    React to every finding (answer or dismiss) to enable.
                  </template>
                </p>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.pl-5\.5 {
  padding-left: 1.375rem;
}
/* Minimal CommonMark styling for the reworked requirements reader (mirrors the
   prose review window's reader-prose). */
.reader-prose :deep(p) {
  margin: 0.4rem 0;
}
.reader-prose :deep(ul),
.reader-prose :deep(ol) {
  margin: 0.4rem 0;
  padding-left: 1.25rem;
  list-style: revert;
}
.reader-prose :deep(li) {
  margin: 0.2rem 0;
}
.reader-prose :deep(strong) {
  color: rgb(226 232 240);
  font-weight: 600;
}
.reader-prose :deep(code) {
  border-radius: 0.25rem;
  background: rgb(2 6 23 / 0.6);
  padding: 0.05rem 0.3rem;
  font-size: 0.85em;
}
.reader-prose :deep(pre) {
  margin: 0.5rem 0;
  overflow-x: auto;
  border-radius: 0.5rem;
  background: rgb(2 6 23 / 0.6);
  padding: 0.75rem;
}
.reader-prose :deep(blockquote) {
  margin: 0.5rem 0;
  border-left: 2px solid rgb(51 65 85);
  padding-left: 0.75rem;
  color: rgb(148 163 184);
}
</style>
