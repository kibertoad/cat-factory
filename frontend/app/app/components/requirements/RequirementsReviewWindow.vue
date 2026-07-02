<script setup lang="ts">
// Requirements review window — the dedicated surface for the `requirements-review` gate
// step (opened via the universal result-view host). The human reacts to the reviewer's
// structured findings (answer the relevant, dismiss the irrelevant), then asks to
// incorporate. Incorporation + the re-review run ASYNCHRONOUSLY in the durable driver: the
// window closes and the user returns to the board, and is summoned back (a notification)
// only if the re-review raises new findings or hits the iteration cap. The incorporated
// document — not the original description + linked docs/tasks — is what every downstream
// agent step and the spec-writer consume.
import { parseOutputOutline } from '~/utils/agentOutput'
import StepRestartControl from '~/components/panels/StepRestartControl.vue'
import IterationCapPrompt from '~/components/pipeline/IterationCapPrompt.vue'
import type {
  RequirementRecommendation,
  RequirementReview,
  RequirementReviewItem,
  ReviewItemCategory,
  ReviewItemSeverity,
  ReviewItemStatus,
} from '~/types/requirements'

const board = useBoardStore()
const requirements = useRequirementsStore()
const toast = useToast()
const { t } = useI18n()

// Draft replies, keyed by item id, so editing one item doesn't disturb others.
const drafts = ref<Record<string, string>>({})
// The server-side reply each draft was last seeded/synced to, so the seeding watch can refresh
// a draft when the recorded reply changes server-side (e.g. accepting a recommendation sets the
// finding's answer) WITHOUT clobbering a reply the human is actively editing.
const seededReply = ref<Record<string, string>>({})
// Findings the human marked for a Requirement-Writer recommendation, batched until they
// click "Request recommendations" (so the Writer runs once over the whole batch).
const markedForRecommend = ref<Set<string>>(new Set())
// Re-request "do it differently" notes, keyed by recommendation id.
const reRequestNotes = ref<Record<string, string>>({})
// Freeform "do it differently" comment when redoing a merge the human was unhappy with.
const redoComment = ref('')
const showRedo = ref(false)

// The seam contract (open/blockId/close + Escape handling + load-on-open) lives in
// `useResultView`, so this window can't drift from the others. Declaring `onOpen` makes the
// review load on EVERY open regardless of navigation route: the host mounts this window
// fresh each open, so a non-immediate per-window watch used to leave it empty for whichever
// route (a pipeline step / "Review & approve") didn't warm the cache by selecting the block.
const { open, blockId, instanceId, stepIndex, close } = useResultView('requirements-review', {
  onOpen: (id) => {
    drafts.value = {}
    seededReply.value = {}
    markedForRecommend.value = new Set()
    reRequestNotes.value = {}
    redoComment.value = ''
    showRedo.value = false
    void requirements.load(id)
  },
})
const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const review = computed<RequirementReview | null>(() =>
  blockId.value ? requirements.reviewFor(blockId.value) : null,
)
const busy = computed(() => (blockId.value ? requirements.isReviewing(blockId.value) : false))
// True while the initial fetch of an existing review is in flight (opening the window),
// before the cache is populated — so we show a spinner instead of the empty state.
const loading = computed(() => (blockId.value ? requirements.isLoading(blockId.value) : false))
const reworking = computed(() =>
  review.value ? requirements.isIncorporating(review.value.id) : false,
)
const acting = ref(false)

const SEVERITY_RANK: Record<ReviewItemSeverity, number> = { high: 0, medium: 1, low: 2 }
const sortedItems = computed<RequirementReviewItem[]>(() => {
  if (!review.value) return []
  return [...review.value.items].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  )
})

const openCount = computed(() => (review.value ? requirements.openCount(review.value) : 0))
const answeredCount = computed(() => (review.value ? requirements.answeredCount(review.value) : 0))
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
// No edits while the requirements are settled or a cycle is running in the background.
const frozen = computed(() => incorporated.value || working.value)
const canIncorporate = computed(() => !!review.value && requirements.canIncorporate(review.value))
const canProceed = computed(() => !!review.value && requirements.canProceed(review.value))
const iteration = computed(() => review.value?.iteration ?? 1)
const maxIterations = computed(() => review.value?.maxIterations ?? 1)

// The incorporated document rendered as collapsible markdown (same reader the prose
// review window uses), shown once the companion has produced one.
const outline = computed(() =>
  review.value?.incorporatedRequirements
    ? parseOutputOutline(review.value.incorporatedRequirements)
    : null,
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
  recommend_requested: 'primary',
} as const satisfies Record<ReviewItemStatus, string>

// Exhaustive enum→label maps of literal keys, so the typed-key drift guard sees each key
// (vs a runtime-built `requirements.severity.${value}`).
const SEVERITY_LABELS = computed<Record<ReviewItemSeverity, string>>(() => ({
  high: t('requirements.severity.high'),
  medium: t('requirements.severity.medium'),
  low: t('requirements.severity.low'),
}))
const CATEGORY_LABELS = computed<Record<ReviewItemCategory, string>>(() => ({
  gap: t('requirements.category.gap'),
  clarification: t('requirements.category.clarification'),
  assumption: t('requirements.category.assumption'),
  risk: t('requirements.category.risk'),
  question: t('requirements.category.question'),
}))
const STATUS_LABELS = computed<Record<ReviewItemStatus, string>>(() => ({
  open: t('requirements.itemStatus.open'),
  answered: t('requirements.itemStatus.answered'),
  resolved: t('requirements.itemStatus.resolved'),
  dismissed: t('requirements.itemStatus.dismissed'),
  recommend_requested: t('requirements.itemStatus.recommend_requested'),
}))

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

// Answers auto-save: there is no explicit "save" button. The textarea is pre-seeded with
// the recorded reply (see the watch below); editing and blurring persists it. Persist only
// when the trimmed draft actually differs from what's already recorded, so blurring an
// untouched field is a no-op.
async function persistDraft(item: RequirementReviewItem) {
  if (!review.value || frozen.value) return
  const text = (drafts.value[item.id] ?? '').trim()
  if (!text || text === (item.reply ?? '').trim()) return
  try {
    await requirements.reply(review.value, item.id, text)
  } catch (e) {
    notifyError(t('requirements.errors.saveAnswer'), e)
  }
}

// Persist every dirty draft before an action that consumes the answers, so a value the
// user typed but never blurred out of isn't lost.
async function flushDrafts() {
  if (!review.value) return
  for (const item of review.value.items) {
    if (item.status === 'open' || item.status === 'answered') await persistDraft(item)
  }
}

// Seed a draft for each finding from its recorded reply so the textarea shows the current
// answer (editing in place). New findings from a re-review get seeded; and when the recorded
// reply changes server-side (e.g. accepting a recommendation writes the finding's answer) a
// draft the user hasn't diverged from is refreshed to match. Drafts the user is actively
// editing are left untouched.
watch(
  review,
  (r) => {
    if (!r) return
    const nextDrafts = { ...drafts.value }
    const nextSeeded = { ...seededReply.value }
    let changed = false
    for (const item of r.items) {
      const reply = item.reply ?? ''
      if (!(item.id in nextDrafts)) {
        nextDrafts[item.id] = reply
        nextSeeded[item.id] = reply
        changed = true
        continue
      }
      const draft = nextDrafts[item.id] ?? ''
      const seeded = nextSeeded[item.id] ?? ''
      if (draft === seeded && draft !== reply) {
        // The user hasn't diverged from the last seeded value but the server reply changed —
        // refresh the textarea to the new answer (e.g. an accepted recommendation).
        nextDrafts[item.id] = reply
        nextSeeded[item.id] = reply
        changed = true
      } else if (draft === reply && seeded !== reply) {
        // The draft already matches the server (e.g. the user's answer was just persisted) —
        // record it so a later server-side change can be detected.
        nextSeeded[item.id] = reply
        changed = true
      }
    }
    if (changed) {
      drafts.value = nextDrafts
      seededReply.value = nextSeeded
    }
  },
  { immediate: true },
)

async function setStatus(item: RequirementReviewItem, itemStatus: ReviewItemStatus) {
  if (!review.value) return
  try {
    await requirements.setItemStatus(review.value, item.id, itemStatus)
  } catch (e) {
    notifyError(t('requirements.errors.updateFinding'), e)
  }
}

// --- Requirement Writer recommendations -----------------------------------
const recommending = computed(() =>
  blockId.value ? requirements.isRecommending(blockId.value) : false,
)
// Recommendations the Writer has produced that still await a human decision (`ready`).
const readyRecommendations = computed<RequirementRecommendation[]>(() =>
  (review.value?.recommendations ?? []).filter((r) => r.status === 'ready'),
)
// Placeholders the Requirement Writer is still producing in the background (`pending`).
const generatingRecommendations = computed<RequirementRecommendation[]>(() =>
  (review.value?.recommendations ?? []).filter((r) => r.status === 'pending'),
)
// "ready / total" progress for the in-flight batch (null when nothing is generating). Scoped to
// the current wave via `createdAt` (all placeholders in one request share the timestamp), so
// stale `ready` recommendations the human hasn't acted on from an earlier batch don't inflate it.
const recommendationProgress = computed(() => {
  const generating = generatingRecommendations.value
  if (generating.length === 0) return null
  const batchTimes = new Set(generating.map((r) => r.createdAt))
  const ready = readyRecommendations.value.filter((r) => batchTimes.has(r.createdAt)).length
  return { ready, total: ready + generating.length }
})
function isMarkedForRecommend(item: RequirementReviewItem): boolean {
  return markedForRecommend.value.has(item.id)
}
function toggleRecommend(item: RequirementReviewItem) {
  const next = new Set(markedForRecommend.value)
  if (next.has(item.id)) next.delete(item.id)
  else next.add(item.id)
  markedForRecommend.value = next
}

// Fire the Writer over the whole marked batch (grounded on the project's best-practice
// standards, specs/tech-specs and web search). ASYNCHRONOUS: it returns at once with `pending`
// placeholders that fill in live; the user can close the window and is notified when the batch
// is ready. Flush any typed-but-unblurred answers first so nothing the human entered is lost.
async function requestRecommendations() {
  if (!blockId.value || markedForRecommend.value.size === 0) return
  const ids = [...markedForRecommend.value]
  try {
    await flushDrafts()
    const updated = await requirements.requestRecommendations(blockId.value, ids)
    markedForRecommend.value = new Set()
    const n = ids.length
    // On a parked run the request returns at once with `pending` placeholders the durable driver
    // fills in the background; off-path (no active pipeline) there is no driver, so the Writer
    // ran inline and the recommendations are already settled. Tell the human which actually
    // happened rather than always promising a background callback.
    const stillGenerating = (updated?.recommendations ?? []).some((r) => r.status === 'pending')
    toast.add(
      stillGenerating
        ? {
            title: t('requirements.toast.preparingRecommendations', { count: n }, n),
            description: t('requirements.toast.preparingRecommendationsDescription'),
            icon: 'i-lucide-sparkles',
          }
        : {
            title: t('requirements.toast.recommendationsReady', { count: n }, n),
            icon: 'i-lucide-sparkles',
          },
    )
  } catch (e) {
    notifyError(t('requirements.errors.requestRecommendations'), e)
  }
}

async function acceptRecommendation(rec: RequirementRecommendation) {
  if (!review.value) return
  try {
    await requirements.acceptRecommendation(review.value, rec.id)
  } catch (e) {
    notifyError(t('requirements.errors.acceptRecommendation'), e)
  }
}

async function rejectRecommendation(rec: RequirementRecommendation) {
  if (!review.value) return
  try {
    await requirements.rejectRecommendation(review.value, rec.id)
  } catch (e) {
    notifyError(t('requirements.errors.rejectRecommendation'), e)
  }
}

async function reRequestRecommendation(rec: RequirementRecommendation) {
  if (!review.value) return
  const note = (reRequestNotes.value[rec.id] ?? '').trim()
  if (!note) return
  try {
    await requirements.reRequestRecommendation(review.value, rec.id, note)
    reRequestNotes.value = { ...reRequestNotes.value, [rec.id]: '' }
  } catch (e) {
    notifyError(t('requirements.errors.reRequestRecommendation'), e)
  }
}

async function incorporate(feedback?: string) {
  if (!review.value || !blockId.value) return
  try {
    await flushDrafts()
    await requirements.incorporate(review.value, feedback)
  } catch (e) {
    notifyError(t('requirements.errors.incorporate'), e)
    return
  }
  redoComment.value = ''
  showRedo.value = false
  // The fold + re-review now run in the durable driver. Hand the user back to the board;
  // a notification calls them back only if the re-review needs more input.
  toast.add({
    title: t('requirements.toast.incorporating'),
    description: t('requirements.toast.incorporatingDescription'),
    icon: 'i-lucide-wand-sparkles',
  })
  close()
}

async function reReview() {
  if (!blockId.value) return
  try {
    const updated = await requirements.reReview(blockId.value)
    const newFindings = requirements.openCount(updated)
    toast.add({
      title:
        updated.status === 'incorporated'
          ? t('requirements.toast.reviewerSatisfied')
          : updated.status === 'exceeded'
            ? t('requirements.toast.iterationLimitReached')
            : t('requirements.toast.newFindings', { count: newFindings }, newFindings),
      icon: 'i-lucide-sparkles',
    })
  } catch (e) {
    notifyError(t('requirements.errors.reReview'), e)
  }
}

async function proceed() {
  if (!blockId.value) return
  acting.value = true
  try {
    await flushDrafts()
    await requirements.proceed(blockId.value)
    toast.add({ title: t('requirements.toast.proceeding'), icon: 'i-lucide-arrow-right' })
  } catch (e) {
    notifyError(t('requirements.errors.proceed'), e)
  } finally {
    acting.value = false
  }
}

async function resolveExceeded(choice: 'extra-round' | 'proceed' | 'stop-reset') {
  if (!blockId.value) return
  acting.value = true
  try {
    await requirements.resolveExceeded(blockId.value, choice)
    if (choice === 'stop-reset') {
      toast.add({ title: t('requirements.toast.taskReset'), icon: 'i-lucide-undo' })
      close()
    } else if (choice === 'proceed') {
      toast.add({ title: t('requirements.toast.proceeding'), icon: 'i-lucide-arrow-right' })
    } else {
      toast.add({ title: t('requirements.toast.extraRoundGranted'), icon: 'i-lucide-rotate-cw' })
    }
  } catch (e) {
    notifyError(t('requirements.errors.resolveReview'), e)
  } finally {
    acting.value = false
  }
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
        role="dialog"
        aria-modal="true"
      >
        <!-- header -->
        <header class="flex items-center gap-3 border-b border-slate-800 px-6 py-4">
          <div
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15"
          >
            <UIcon name="i-lucide-clipboard-check" class="h-5 w-5 text-indigo-300" />
          </div>
          <div class="min-w-0">
            <h1 class="truncate text-base font-semibold text-white">
              {{ t('requirements.title') }}
            </h1>
            <p v-if="block" class="truncate text-xs text-slate-500">{{ block.title }}</p>
          </div>
          <div class="ms-auto flex items-center gap-1.5">
            <UBadge v-if="review" color="neutral" variant="subtle" size="sm">
              {{ t('requirements.iteration', { current: iteration, max: maxIterations }) }}
            </UBadge>
            <StepRestartControl
              :instance-id="instanceId"
              :step-index="stepIndex"
              @restarted="close"
            />
            <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="sm" @click="close" />
          </div>
        </header>

        <div class="flex min-h-0 flex-1">
          <!-- main column -->
          <div class="min-w-0 flex-1 overflow-y-auto px-6 py-5">
            <i18n-t
              keypath="requirements.intro"
              tag="p"
              class="mb-4 text-sm text-slate-400"
              scope="global"
            >
              <template #level>{{ block?.level ?? t('requirements.levelFallback') }}</template>
              <template #answer
                ><span class="text-slate-300">{{ t('requirements.answerVerb') }}</span></template
              >
              <template #dismiss
                ><span class="text-slate-300">{{ t('requirements.dismissVerb') }}</span></template
              >
            </i18n-t>

            <!-- empty state — the reviewer runs automatically as the first pipeline
                 gate step, so there's nothing to do here until then -->
            <div
              v-if="!review && !busy && !loading"
              class="rounded-lg border border-dashed border-slate-700 p-8 text-center text-sm text-slate-500"
            >
              {{ t('requirements.empty') }}
            </div>

            <!-- working state (initial fetch on open, or a reviewer pass running) -->
            <div
              v-else-if="(busy || loading) && !review"
              class="flex items-center justify-center gap-2 p-8 text-sm text-slate-400"
            >
              <UIcon name="i-lucide-loader-circle" class="h-4 w-4 animate-spin" />
              {{ loading && !busy ? t('requirements.loadingReview') : t('requirements.reviewing') }}
            </div>

            <template v-else-if="review">
              <!-- converged: reviewer satisfied -->
              <div
                v-if="incorporated"
                class="mb-4 flex items-center gap-2 rounded-lg border border-emerald-900/60 bg-emerald-950/30 p-4 text-sm text-emerald-300"
              >
                <UIcon name="i-lucide-circle-check" class="h-5 w-5 shrink-0" />
                {{ t('requirements.settled') }}
              </div>

              <!-- iteration cap hit -->
              <IterationCapPrompt
                v-else-if="exceeded"
                class="mb-4"
                :heading="t('requirements.exceeded.heading', { max: maxIterations })"
                :detail="t('requirements.exceeded.detail')"
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
                  {{ t('requirements.working.incorporating') }}
                </span>
                <span v-else>
                  {{ t('requirements.working.reReviewing') }}
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
                          {{ SEVERITY_LABELS[item.severity] }}
                        </UBadge>
                        <UBadge size="xs" variant="outline" color="neutral">
                          {{ CATEGORY_LABELS[item.category] }}
                        </UBadge>
                        <UBadge
                          size="xs"
                          variant="soft"
                          :color="STATUS_COLOR[item.status]"
                          class="ms-auto"
                        >
                          {{ STATUS_LABELS[item.status] }}
                        </UBadge>
                      </div>
                      <p class="mt-1 whitespace-pre-line text-sm text-slate-400">
                        {{ item.detail }}
                      </p>

                      <!-- recorded answer (only for non-editable findings — for editable
                           ones the answer lives in the textarea below, seeded from the reply) -->
                      <div
                        v-if="item.reply && item.status !== 'open' && item.status !== 'answered'"
                        class="mt-2 rounded-md border-s-2 border-slate-700 bg-slate-950/40 px-3 py-1.5 text-sm text-slate-300"
                      >
                        <span class="text-[10px] uppercase tracking-wide text-slate-500">
                          {{ t('requirements.answerLabel') }}
                        </span>
                        <p class="whitespace-pre-line">{{ item.reply }}</p>
                      </div>

                      <!-- react: answer (relevant) or dismiss (irrelevant). The answer
                           auto-saves on blur — no explicit save button. Disabled once the
                           requirements are settled / awaiting a higher-level decision. -->
                      <template v-if="item.status === 'open' || item.status === 'answered'">
                        <UTextarea
                          v-model="drafts[item.id]"
                          :rows="2"
                          autoresize
                          size="sm"
                          class="mt-2 w-full"
                          :placeholder="t('requirements.answerPlaceholder')"
                          :disabled="frozen"
                          @blur="persistDraft(item)"
                        />
                        <div class="mt-2 flex flex-wrap items-center gap-2">
                          <UButton
                            color="neutral"
                            variant="ghost"
                            size="xs"
                            icon="i-lucide-x"
                            :disabled="frozen"
                            @click="setStatus(item, 'dismissed')"
                          >
                            {{ t('requirements.dismissIrrelevant') }}
                          </UButton>
                          <UButton
                            :color="isMarkedForRecommend(item) ? 'primary' : 'neutral'"
                            :variant="isMarkedForRecommend(item) ? 'soft' : 'ghost'"
                            size="xs"
                            icon="i-lucide-wand-2"
                            :disabled="frozen"
                            @click="toggleRecommend(item)"
                          >
                            {{
                              isMarkedForRecommend(item)
                                ? t('requirements.markedForRecommendation')
                                : t('requirements.recommendSomething')
                            }}
                          </UButton>
                        </div>
                      </template>

                      <!-- finding awaiting a recommendation batch -->
                      <div
                        v-else-if="item.status === 'recommend_requested'"
                        class="mt-2 flex items-center gap-1.5 text-xs text-indigo-300"
                      >
                        <UIcon name="i-lucide-wand-2" class="h-3.5 w-3.5" />
                        {{ t('requirements.recommendationRequested') }}
                      </div>

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
                          {{ t('requirements.reopen') }}
                        </UButton>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Requirement-Writer recommendations: awaiting a human decision (`ready`) and/or
                   still generating in the background (`pending`) -->
              <section
                v-if="readyRecommendations.length || generatingRecommendations.length"
                class="mt-6 border-t border-slate-800 pt-5"
              >
                <div class="mb-3 flex items-center gap-2 text-[11px] text-indigo-300">
                  <UIcon name="i-lucide-wand-2" class="h-3.5 w-3.5" />
                  <span class="font-semibold uppercase tracking-wide">{{
                    t('requirements.recommendedAnswers')
                  }}</span>
                  <span
                    v-if="recommendationProgress"
                    class="ms-auto flex items-center gap-1.5 normal-case text-indigo-300/80"
                  >
                    <UIcon name="i-lucide-loader-circle" class="h-3.5 w-3.5 animate-spin" />
                    {{
                      t('requirements.recommendationProgress', {
                        ready: recommendationProgress.ready,
                        total: recommendationProgress.total,
                      })
                    }}
                  </span>
                </div>

                <!-- still-generating placeholders (one per requested finding) -->
                <div v-if="generatingRecommendations.length" class="mb-3 flex flex-col gap-3">
                  <div
                    v-for="rec in generatingRecommendations"
                    :key="rec.id"
                    class="flex items-start gap-2 rounded-lg border border-dashed border-indigo-900/50 bg-indigo-950/10 p-3"
                  >
                    <UIcon
                      name="i-lucide-loader-circle"
                      class="mt-0.5 h-4 w-4 shrink-0 animate-spin text-indigo-300"
                    />
                    <div class="min-w-0">
                      <span class="text-sm font-medium text-white">{{
                        rec.sourceFinding.title
                      }}</span>
                      <p class="text-xs text-indigo-300/70">
                        {{ t('requirements.generatingSuggestion') }}
                      </p>
                    </div>
                  </div>
                </div>

                <div class="flex flex-col gap-3">
                  <div
                    v-for="rec in readyRecommendations"
                    :key="rec.id"
                    class="rounded-lg border border-indigo-900/50 bg-indigo-950/20 p-3"
                  >
                    <div class="flex flex-wrap items-center gap-1.5">
                      <span class="text-sm font-medium text-white">{{
                        rec.sourceFinding.title
                      }}</span>
                      <UBadge
                        v-if="rec.groundedInFragment"
                        size="xs"
                        variant="subtle"
                        color="success"
                        icon="i-lucide-badge-check"
                      >
                        {{
                          t('requirements.currentStandard', { title: rec.groundedInFragment.title })
                        }}
                      </UBadge>
                    </div>
                    <p class="mt-2 whitespace-pre-line text-sm text-slate-300">
                      {{ rec.recommendedText }}
                    </p>
                    <div class="mt-2 flex flex-wrap items-center gap-2">
                      <UButton
                        color="primary"
                        variant="soft"
                        size="xs"
                        icon="i-lucide-check"
                        :disabled="frozen"
                        @click="acceptRecommendation(rec)"
                      >
                        {{ t('requirements.accept') }}
                      </UButton>
                      <UButton
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        icon="i-lucide-x"
                        :disabled="frozen"
                        @click="rejectRecommendation(rec)"
                      >
                        {{ t('requirements.reject') }}
                      </UButton>
                    </div>
                    <!-- re-request with a note (an alternative to rejecting outright) -->
                    <div class="mt-2 flex items-start gap-2">
                      <UTextarea
                        v-model="reRequestNotes[rec.id]"
                        :rows="1"
                        autoresize
                        size="sm"
                        class="flex-1"
                        :placeholder="t('requirements.reRequestPlaceholder')"
                        :disabled="frozen || recommending"
                      />
                      <UButton
                        color="neutral"
                        variant="soft"
                        size="xs"
                        icon="i-lucide-rotate-cw"
                        :loading="recommending"
                        :disabled="!(reRequestNotes[rec.id] ?? '').trim() || frozen"
                        @click="reRequestRecommendation(rec)"
                      >
                        {{ t('requirements.reRequest') }}
                      </UButton>
                    </div>
                  </div>
                </div>
              </section>

              <!-- incorporated document: the standard-format requirements -->
              <section v-if="outline" class="mt-6 border-t border-slate-800 pt-5">
                <div class="mb-3 flex items-center gap-1.5 text-[11px] text-emerald-400">
                  <UIcon name="i-lucide-file-check-2" class="h-3.5 w-3.5" />
                  <span class="font-semibold uppercase tracking-wide">
                    {{
                      incorporated
                        ? t('requirements.finalRequirements')
                        : t('requirements.incorporatedDraft')
                    }}
                  </span>
                </div>
                <div v-for="s in outline.sections" :key="s.id" class="mb-2">
                  <button
                    v-if="s.title"
                    class="group flex w-full items-center gap-2 text-start"
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
                    class="reader-prose mt-1 ps-5.5 text-[13px] leading-relaxed text-slate-300"
                    v-html="s.bodyHtml"
                  />
                </div>
              </section>
            </template>
          </div>

          <!-- right action rail -->
          <aside class="hidden w-72 shrink-0 flex-col border-s border-slate-800 lg:flex">
            <div class="flex flex-col gap-4 px-4 py-5">
              <div v-if="review" class="space-y-2 text-xs text-slate-400">
                <div class="flex items-center justify-between">
                  <span>{{ t('requirements.stats.findings') }}</span>
                  <span class="text-slate-300">{{ review.items.length }}</span>
                </div>
                <div class="flex items-center justify-between">
                  <span>{{ t('requirements.stats.open') }}</span>
                  <span class="text-slate-300">{{ openCount }}</span>
                </div>
                <div class="flex items-center justify-between">
                  <span>{{ t('requirements.stats.answered') }}</span>
                  <span class="text-slate-300">{{ answeredCount }}</span>
                </div>
                <div v-if="review.model" class="flex items-center justify-between">
                  <span>{{ t('requirements.stats.model') }}</span>
                  <span class="truncate ps-2 text-slate-500">{{ review.model }}</span>
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
                  :ui="{ leadingIcon: 'rtl:-scale-x-100', trailingIcon: 'rtl:-scale-x-100' }"
                  :loading="acting"
                  @click="proceed"
                >
                  {{ t('requirements.actions.proceedNothing') }}
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
                  {{ t('requirements.actions.incorporateAnswers') }}
                </UButton>
                <UButton
                  v-if="markedForRecommend.size > 0"
                  color="primary"
                  variant="soft"
                  size="sm"
                  block
                  icon="i-lucide-wand-2"
                  :loading="recommending"
                  @click="requestRecommendations"
                >
                  {{
                    t(
                      'requirements.actions.requestRecommendations',
                      { count: markedForRecommend.size },
                      markedForRecommend.size,
                    )
                  }}
                </UButton>
                <p class="text-[11px] leading-relaxed text-slate-500">
                  <template v-if="canProceed">
                    {{ t('requirements.help.canProceed') }}
                  </template>
                  <template v-else-if="canIncorporate">
                    {{ t('requirements.help.canIncorporate') }}
                  </template>
                  <template v-else> {{ t('requirements.help.answerAll') }} </template>
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
                  {{
                    busy
                      ? t('requirements.actions.reReviewing')
                      : t('requirements.actions.reReview')
                  }}
                </UButton>
                <UButton
                  color="neutral"
                  variant="soft"
                  size="sm"
                  block
                  icon="i-lucide-pencil"
                  @click="showRedo = !showRedo"
                >
                  {{ t('requirements.actions.redoIncorporation') }}
                </UButton>
                <div v-if="showRedo" class="space-y-2">
                  <UTextarea
                    v-model="redoComment"
                    :rows="3"
                    autoresize
                    size="sm"
                    class="w-full"
                    :placeholder="t('requirements.redoPlaceholder')"
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
                    {{ t('requirements.actions.redoWithDirection') }}
                  </UButton>
                </div>
                <p class="text-[11px] leading-relaxed text-slate-500">
                  {{ t('requirements.help.merged') }}
                </p>
              </div>

              <div
                v-if="review && incorporated"
                class="border-t border-slate-800 pt-4 text-[11px] leading-relaxed text-slate-500"
              >
                {{ t('requirements.settledFooter') }}
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
/* Minimal CommonMark styling for the incorporated requirements reader (mirrors the
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
