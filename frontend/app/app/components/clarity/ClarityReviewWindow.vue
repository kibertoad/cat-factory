<script setup lang="ts">
// Clarity review window — the dedicated surface for the `clarity-review` gate step
// (opened via the universal result-view host). The human reacts to the reviewer's
// structured triage of a BUG REPORT (answer the relevant questions, dismiss the
// irrelevant), then asks to incorporate. Incorporation + the re-review run
// ASYNCHRONOUSLY in the durable driver: the window closes and the user returns to the
// board, and is summoned back (a notification) only if the re-review raises new
// findings or hits the iteration cap. The clarified bug report — not the original
// description — is what every downstream agent step (the bug investigator, the coder)
// consumes.
import { parseOutputOutline } from '~/utils/agentOutput'
import type { UpdateClarityItemStatusInput } from '@cat-factory/contracts'
import type {
  ClarityReview,
  ClarityReviewItem,
  ReviewItemCategory,
  ReviewItemSeverity,
  ReviewItemStatus,
} from '~/types/clarity'

// The status a clarity item can be set to (narrower than the shared ReviewItemStatus).
type ClarityItemStatus = UpdateClarityItemStatusInput['status']

const board = useBoardStore()
const clarity = useClarityStore()
const toast = useToast()

// Draft replies, keyed by item id, so editing one item doesn't disturb others.
const drafts = ref<Record<string, string>>({})
// Freeform "do it differently" comment when redoing a merge the human was unhappy with.
const redoComment = ref('')
const showRedo = ref(false)

// The seam contract (open/blockId/close + Escape handling + load-on-open) lives in
// `useResultView`, so this window can't drift from the others. Declaring `onOpen` makes the
// review load on EVERY open regardless of navigation route: the host mounts this window
// fresh each open, so a non-immediate per-window watch used to leave it empty for whichever
// route (a pipeline step / "Review & approve") didn't warm the cache by selecting the block.
const { open, blockId, close } = useResultView('clarity-review', {
  onOpen: (id) => {
    drafts.value = {}
    redoComment.value = ''
    showRedo.value = false
    void clarity.load(id)
  },
})
const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const review = computed<ClarityReview | null>(() =>
  blockId.value ? clarity.reviewFor(blockId.value) : null,
)
const busy = computed(() => (blockId.value ? clarity.isReviewing(blockId.value) : false))
// True while the initial fetch of an existing review is in flight (opening the window),
// before the cache is populated — so we show a spinner instead of the empty state.
const loading = computed(() => (blockId.value ? clarity.isLoading(blockId.value) : false))
const reworking = computed(() => (review.value ? clarity.isIncorporating(review.value.id) : false))
const acting = ref(false)

const SEVERITY_RANK: Record<ReviewItemSeverity, number> = { high: 0, medium: 1, low: 2 }
const sortedItems = computed<ClarityReviewItem[]>(() => {
  if (!review.value) return []
  return [...review.value.items].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  )
})

const openCount = computed(() => (review.value ? clarity.openCount(review.value) : 0))
const answeredCount = computed(() => (review.value ? clarity.answeredCount(review.value) : 0))
const status = computed(() => review.value?.status ?? null)
const merged = computed(() => status.value === 'merged')
const exceeded = computed(() => status.value === 'exceeded')
const incorporated = computed(() => status.value === 'incorporated')
// The async cycle runs in the driver in two stages — folding the answers (`incorporating`)
// then re-reviewing the document (`reviewing`). The window normally closes the moment
// incorporation is requested; these states only show if it's later re-opened mid-cycle.
const incorporating = computed(() => status.value === 'incorporating')
const reReviewing = computed(() => status.value === 'reviewing')
const working = computed(() => incorporating.value || reReviewing.value)
// No edits while the bug report is clarified or a cycle is running in the background.
const frozen = computed(() => incorporated.value || working.value)
const canIncorporate = computed(() => !!review.value && clarity.canIncorporate(review.value))
const canProceed = computed(() => !!review.value && clarity.canProceed(review.value))
const iteration = computed(() => review.value?.iteration ?? 1)
const maxIterations = computed(() => review.value?.maxIterations ?? 1)

// The clarified bug report rendered as collapsible markdown (same reader the prose
// review window uses), shown once the companion has produced one.
const outline = computed(() =>
  review.value?.clarifiedReport ? parseOutputOutline(review.value.clarifiedReport) : null,
)
const collapsed = ref<Record<string, boolean>>({})
function toggle(id: string) {
  collapsed.value = { ...collapsed.value, [id]: !collapsed.value[id] }
}

const SEVERITY_COLOR = {
  high: 'error',
  medium: 'warning',
  low: 'neutral',
} as const satisfies Record<ReviewItemSeverity, string>
const CATEGORY_ICON: Record<ReviewItemCategory, string> = {
  gap: 'i-lucide-puzzle',
  clarification: 'i-lucide-help-circle',
  assumption: 'i-lucide-lightbulb',
  risk: 'i-lucide-shield-alert',
  question: 'i-lucide-message-circle-question',
}
const STATUS_COLOR = {
  open: 'warning',
  answered: 'info',
  resolved: 'success',
  dismissed: 'neutral',
  // Clarity review doesn't request Requirement-Writer recommendations, but the item-status
  // type is shared with the requirements review, so the map must be exhaustive.
  recommend_requested: 'primary',
} as const satisfies Record<ReviewItemStatus, string>

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

async function submitReply(item: ClarityReviewItem) {
  if (!review.value) return
  const text = (drafts.value[item.id] ?? '').trim()
  if (!text) return
  try {
    await clarity.reply(review.value, item.id, text)
    drafts.value = { ...drafts.value, [item.id]: '' }
  } catch (e) {
    notifyError('Could not save the answer', e)
  }
}

async function setStatus(item: ClarityReviewItem, itemStatus: ClarityItemStatus) {
  if (!review.value) return
  try {
    await clarity.setItemStatus(review.value, item.id, itemStatus)
  } catch (e) {
    notifyError('Could not update the finding', e)
  }
}

async function incorporate(feedback?: string) {
  if (!review.value || !blockId.value) return
  try {
    await clarity.incorporate(review.value, feedback)
  } catch (e) {
    notifyError('Could not incorporate the answers', e)
    return
  }
  redoComment.value = ''
  showRedo.value = false
  // The fold + re-review now run in the durable driver. Hand the user back to the board;
  // a notification calls them back only if the re-review needs more input.
  toast.add({
    title: 'Clarifying the bug report in the background',
    description: "You're back on the board — we'll notify you only if more input is needed.",
    icon: 'i-lucide-wand-sparkles',
  })
  close()
}

async function reReview() {
  if (!blockId.value) return
  try {
    const updated = await clarity.reReview(blockId.value)
    toast.add({
      title:
        updated.status === 'incorporated'
          ? 'Reviewer is satisfied — continuing the pipeline'
          : updated.status === 'exceeded'
            ? 'Iteration limit reached — choose how to proceed'
            : `${clarity.openCount(updated)} new finding(s) to react to`,
      icon: 'i-lucide-sparkles',
    })
  } catch (e) {
    notifyError('Could not re-review the bug report', e)
  }
}

async function proceed() {
  if (!blockId.value) return
  acting.value = true
  try {
    await clarity.proceed(blockId.value)
    toast.add({ title: 'Proceeding to the next phase', icon: 'i-lucide-arrow-right' })
  } catch (e) {
    notifyError('Could not proceed', e)
  } finally {
    acting.value = false
  }
}

async function resolveExceeded(choice: 'extra-round' | 'proceed' | 'stop-reset') {
  if (!blockId.value) return
  acting.value = true
  try {
    await clarity.resolveExceeded(blockId.value, choice)
    if (choice === 'stop-reset') {
      toast.add({ title: 'Task reset — edit the bug report and resubmit', icon: 'i-lucide-undo' })
      close()
    } else if (choice === 'proceed') {
      toast.add({ title: 'Proceeding to the next phase', icon: 'i-lucide-arrow-right' })
    } else {
      toast.add({ title: 'One more review round granted', icon: 'i-lucide-rotate-cw' })
    }
  } catch (e) {
    notifyError('Could not resolve the review', e)
  } finally {
    acting.value = false
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
            <UIcon name="i-lucide-bug" class="h-5 w-5 text-indigo-300" />
          </div>
          <div class="min-w-0">
            <h1 class="truncate text-base font-semibold text-white">Bug-report triage</h1>
            <p v-if="block" class="truncate text-xs text-slate-500">{{ block.title }}</p>
          </div>
          <div class="ml-auto flex items-center gap-1.5">
            <UBadge v-if="review" color="neutral" variant="subtle" size="sm">
              Iteration {{ iteration }} / {{ maxIterations }}
            </UBadge>
            <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="sm" @click="close" />
          </div>
        </header>

        <div class="flex min-h-0 flex-1">
          <!-- main column -->
          <div class="min-w-0 flex-1 overflow-y-auto px-6 py-5">
            <p class="mb-4 text-sm text-slate-400">
              An AI reviewer triaged this {{ block?.level ?? 'item' }}’s bug report for fixability —
              its description plus any linked context — and raised the questions below.
              <span class="text-slate-300">Answer</span> the relevant ones and
              <span class="text-slate-300">dismiss</span> the irrelevant, then incorporate them; the
              reviewer re-reviews until the bug report is clear enough to fix.
            </p>

            <!-- empty state — the reviewer runs automatically as the first pipeline
                 gate step, so there's nothing to do here until then -->
            <div
              v-if="!review && !busy && !loading"
              class="rounded-lg border border-dashed border-slate-700 p-8 text-center text-sm text-slate-500"
            >
              No review yet. The reviewer runs automatically as the first step when this task's
              pipeline starts.
            </div>

            <!-- working state (initial fetch on open, or a reviewer pass running) -->
            <div
              v-else-if="(busy || loading) && !review"
              class="flex items-center justify-center gap-2 p-8 text-sm text-slate-400"
            >
              <UIcon name="i-lucide-loader-circle" class="h-4 w-4 animate-spin" />
              {{ loading && !busy ? 'Loading the review…' : 'Triaging the bug report…' }}
            </div>

            <template v-else-if="review">
              <!-- converged: reviewer satisfied -->
              <div
                v-if="incorporated"
                class="mb-4 flex items-center gap-2 rounded-lg border border-emerald-900/60 bg-emerald-950/30 p-4 text-sm text-emerald-300"
              >
                <UIcon name="i-lucide-circle-check" class="h-5 w-5 shrink-0" />
                The bug report is clarified. The report below is what every downstream agent step
                uses.
              </div>

              <!-- iteration cap hit -->
              <IterationCapPrompt
                v-else-if="exceeded"
                class="mb-4"
                :heading="`Reached the ${maxIterations}-iteration limit with findings still open.`"
                detail="Do one more review round, proceed to the next phase with the last clarified bug report anyway, or stop and reset the task so you can rework the bug report and resubmit."
                :loading="acting"
                @resolve="resolveExceeded"
              />

              <!-- working: the async cycle is running in the driver. Two distinct stages so
                   the human can see which of the two LLM calls is currently in progress. -->
              <div
                v-else-if="working"
                class="mb-4 flex items-center gap-2 rounded-lg border border-indigo-900/60 bg-indigo-950/30 p-4 text-sm text-indigo-200"
              >
                <UIcon name="i-lucide-loader-circle" class="h-5 w-5 shrink-0 animate-spin" />
                <span v-if="incorporating">
                  Incorporating your answers into a clarified bug report… You can close this — we’ll
                  notify you only if more input is needed.
                </span>
                <span v-else>
                  Re-reviewing the updated bug report… You can close this — we’ll notify you only if
                  more input is needed.
                </span>
              </div>

              <!-- findings to react to -->
              <div v-if="review.items.length" class="flex flex-col gap-3">
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
                        <UBadge size="xs" variant="subtle" :color="SEVERITY_COLOR[item.severity]">
                          {{ item.severity }}
                        </UBadge>
                        <UBadge size="xs" variant="outline" color="neutral">
                          {{ item.category }}
                        </UBadge>
                        <UBadge
                          size="xs"
                          variant="soft"
                          :color="STATUS_COLOR[item.status]"
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

                      <!-- react: answer (relevant) or dismiss (irrelevant). Disabled once the
                           bug report is clarified / awaiting a higher-level decision. -->
                      <template v-if="item.status === 'open' || item.status === 'answered'">
                        <UTextarea
                          v-model="drafts[item.id]"
                          :rows="2"
                          autoresize
                          size="sm"
                          class="mt-2 w-full"
                          :placeholder="item.reply ? 'Refine your answer…' : 'Answer this finding…'"
                          :disabled="frozen"
                        />
                        <div class="mt-2 flex flex-wrap items-center gap-2">
                          <UButton
                            color="primary"
                            variant="soft"
                            size="xs"
                            icon="i-lucide-corner-down-left"
                            :disabled="!(drafts[item.id] ?? '').trim() || frozen"
                            @click="submitReply(item)"
                          >
                            Save answer
                          </UButton>
                          <UButton
                            color="neutral"
                            variant="ghost"
                            size="xs"
                            icon="i-lucide-x"
                            :disabled="frozen"
                            @click="setStatus(item, 'dismissed')"
                          >
                            Dismiss as irrelevant
                          </UButton>
                        </div>
                      </template>

                      <!-- reopen a dismissed finding -->
                      <div v-else-if="item.status === 'dismissed'" class="mt-2">
                        <UButton
                          color="neutral"
                          variant="ghost"
                          size="xs"
                          icon="i-lucide-rotate-ccw"
                          :disabled="frozen"
                          @click="setStatus(item, 'open')"
                        >
                          Reopen
                        </UButton>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- clarified document: the standard-format bug report -->
              <section v-if="outline" class="mt-6 border-t border-slate-800 pt-5">
                <div class="mb-3 flex items-center gap-1.5 text-[11px] text-emerald-400">
                  <UIcon name="i-lucide-file-check-2" class="h-3.5 w-3.5" />
                  <span class="font-semibold uppercase tracking-wide">
                    {{ incorporated ? 'Clarified bug report' : 'Clarified bug report (draft)' }}
                  </span>
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
                  <span>Open</span>
                  <span class="text-slate-300">{{ openCount }}</span>
                </div>
                <div class="flex items-center justify-between">
                  <span>Answered</span>
                  <span class="text-slate-300">{{ answeredCount }}</span>
                </div>
                <div v-if="review.model" class="flex items-center justify-between">
                  <span>Model</span>
                  <span class="truncate pl-2 text-slate-500">{{ review.model }}</span>
                </div>
              </div>

              <!-- action: ready (answer → incorporate / proceed) -->
              <div
                v-if="review && status === 'ready'"
                class="space-y-2 border-t border-slate-800 pt-4"
              >
                <UButton
                  v-if="canProceed"
                  color="primary"
                  size="sm"
                  block
                  icon="i-lucide-arrow-right"
                  :loading="acting"
                  @click="proceed"
                >
                  Proceed (nothing to incorporate)
                </UButton>
                <UButton
                  v-else
                  color="primary"
                  size="sm"
                  block
                  icon="i-lucide-wand-sparkles"
                  :loading="reworking"
                  :disabled="!canIncorporate"
                  @click="incorporate()"
                >
                  Incorporate answers
                </UButton>
                <p class="text-[11px] leading-relaxed text-slate-500">
                  <template v-if="canProceed">
                    Every finding is dismissed — proceed to the next phase without reworking.
                  </template>
                  <template v-else-if="canIncorporate">
                    Folds your answers into one clarified bug report, then re-reviews it
                    automatically.
                  </template>
                  <template v-else> Answer or dismiss every finding to continue. </template>
                </p>
              </div>

              <!-- action: merged (inspect → re-review / redo) -->
              <div v-if="review && merged" class="space-y-2 border-t border-slate-800 pt-4">
                <UButton
                  color="primary"
                  size="sm"
                  block
                  icon="i-lucide-sparkles"
                  :loading="busy"
                  @click="reReview"
                >
                  {{ busy ? 'Re-reviewing…' : 'Looks good — re-review' }}
                </UButton>
                <UButton
                  color="neutral"
                  variant="soft"
                  size="sm"
                  block
                  icon="i-lucide-pencil"
                  @click="showRedo = !showRedo"
                >
                  Redo incorporation
                </UButton>
                <div v-if="showRedo" class="space-y-2">
                  <UTextarea
                    v-model="redoComment"
                    :rows="3"
                    autoresize
                    size="sm"
                    class="w-full"
                    placeholder="What should the merge do differently?"
                  />
                  <UButton
                    color="primary"
                    variant="soft"
                    size="xs"
                    block
                    icon="i-lucide-wand-sparkles"
                    :loading="reworking"
                    :disabled="!redoComment.trim()"
                    @click="incorporate(redoComment.trim())"
                  >
                    Redo with this direction
                  </UButton>
                </div>
                <p class="text-[11px] leading-relaxed text-slate-500">
                  Re-review runs the reviewer against this report. If you’re unhappy with how it was
                  merged, redo it with a comment instead.
                </p>
              </div>

              <div
                v-if="review && incorporated"
                class="border-t border-slate-800 pt-4 text-[11px] leading-relaxed text-slate-500"
              >
                Bug report clarified — the pipeline is continuing with the report on the left.
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
/* Minimal CommonMark styling for the clarified bug-report reader (mirrors the
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
