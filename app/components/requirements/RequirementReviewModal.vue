<script setup lang="ts">
// Requirements-review panel: surfaces the stateless reviewer agent's questions /
// gaps / clarifications about a block's collected requirements in a form a human
// can work through — answer or dismiss each item, then incorporate the answers
// back into the block's requirements. Triggered from the inspector; the block id
// to review lives on the ui store.
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

const open = computed({
  get: () => ui.requirementReviewBlockId !== null,
  set: (v: boolean) => {
    if (!v) ui.closeRequirementReview()
  },
})

const blockId = computed(() => ui.requirementReviewBlockId)
const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const review = computed<RequirementReview | null>(() =>
  blockId.value ? requirements.reviewFor(blockId.value) : null,
)
const busy = computed(() => (blockId.value ? requirements.isReviewing(blockId.value) : false))
const incorporating = computed(() =>
  review.value ? requirements.isIncorporating(review.value.id) : false,
)

// Draft replies, keyed by item id, so editing one item doesn't disturb others.
const drafts = ref<Record<string, string>>({})

// Load the current review whenever the panel opens for a block.
watch(blockId, (id) => {
  drafts.value = {}
  if (id) void requirements.load(id)
})

const sortedItems = computed<RequirementReviewItem[]>(() => {
  if (!review.value) return []
  const rank: Record<ReviewItemSeverity, number> = { high: 0, medium: 1, low: 2 }
  return [...review.value.items].sort((a, b) => rank[a.severity] - rank[b.severity])
})

const openCount = computed(() => (review.value ? requirements.openCount(review.value) : 0))
const canIncorporate = computed(() => !!review.value && requirements.allSettled(review.value))

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
        ? `${result.items.length} item(s) to review`
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
    notifyError('Could not update the item', e)
  }
}

async function incorporate() {
  if (!review.value) return
  try {
    await requirements.incorporate(review.value)
    toast.add({ title: 'Answers incorporated into the requirements', icon: 'i-lucide-check-check' })
  } catch (e) {
    notifyError('Could not incorporate the answers', e)
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="Requirements review"
    :description="block?.title"
    :ui="{ content: 'max-w-2xl' }"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <p class="text-sm text-slate-400">
          An AI reviewer inspects this {{ block?.level ?? 'item' }}’s collected requirements — its
          description plus any linked PRDs and tracker issues — and raises gaps, ambiguities and
          questions. Answer or dismiss each, then incorporate the answers back into the
          requirements.
        </p>

        <!-- run / re-run -->
        <div class="flex items-center gap-2">
          <UButton
            color="primary"
            variant="solid"
            size="sm"
            icon="i-lucide-sparkles"
            :loading="busy"
            @click="runReview"
          >
            {{ review ? 'Re-run review' : 'Run review' }}
          </UButton>
          <span v-if="review" class="text-xs text-slate-500">
            {{ review.items.length }} item(s) · {{ openCount }} open
            <template v-if="review.model"> · {{ review.model }}</template>
          </span>
        </div>

        <!-- empty / first-run state -->
        <div
          v-if="!review && !busy"
          class="rounded-lg border border-dashed border-slate-700 p-6 text-center text-sm text-slate-500"
        >
          No review yet. Run the reviewer to surface open questions about the requirements.
        </div>

        <!-- working state -->
        <div
          v-else-if="busy && !review"
          class="flex items-center justify-center gap-2 p-6 text-sm text-slate-400"
        >
          <UIcon name="i-lucide-loader-circle" class="h-4 w-4 animate-spin" />
          Reviewing the requirements…
        </div>

        <!-- no items: requirements look complete -->
        <div
          v-else-if="review && review.items.length === 0"
          class="flex items-center gap-2 rounded-lg border border-emerald-900/60 bg-emerald-950/30 p-4 text-sm text-emerald-300"
        >
          <UIcon name="i-lucide-circle-check" class="h-5 w-5" />
          The reviewer found no gaps — the requirements look complete and unambiguous.
        </div>

        <!-- items -->
        <div v-else-if="review" class="flex flex-col gap-3">
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
                  <UBadge size="xs" variant="subtle" :color="SEVERITY_COLOR[item.severity] as any">
                    {{ item.severity }}
                  </UBadge>
                  <UBadge size="xs" variant="outline" color="neutral">{{ item.category }}</UBadge>
                  <UBadge
                    size="xs"
                    variant="soft"
                    :color="STATUS_COLOR[item.status] as any"
                    class="ml-auto"
                  >
                    {{ item.status }}
                  </UBadge>
                </div>
                <p class="mt-1 whitespace-pre-line text-sm text-slate-400">{{ item.detail }}</p>

                <!-- recorded answer -->
                <div
                  v-if="item.reply"
                  class="mt-2 rounded-md border-l-2 border-slate-700 bg-slate-950/40 px-3 py-1.5 text-sm text-slate-300"
                >
                  <span class="text-[10px] uppercase tracking-wide text-slate-500">Answer</span>
                  <p class="whitespace-pre-line">{{ item.reply }}</p>
                </div>

                <!-- reply + actions (hidden once settled) -->
                <template v-if="item.status !== 'resolved' && item.status !== 'dismissed'">
                  <UTextarea
                    v-model="drafts[item.id]"
                    :rows="2"
                    autoresize
                    size="sm"
                    class="mt-2 w-full"
                    :placeholder="item.reply ? 'Refine your answer…' : 'Answer this question…'"
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
                      Dismiss
                    </UButton>
                  </div>
                </template>

                <!-- reopen a settled item -->
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

          <!-- incorporate -->
          <div class="mt-1 flex items-center gap-2 border-t border-slate-800 pt-3">
            <UButton
              color="primary"
              size="sm"
              icon="i-lucide-check-check"
              :loading="incorporating"
              :disabled="!canIncorporate"
              @click="incorporate"
            >
              Incorporate answers
            </UButton>
            <span class="text-xs text-slate-500">
              <template v-if="review.status === 'incorporated'">
                Answers folded into the requirements.
              </template>
              <template v-else-if="canIncorporate">
                All items settled — fold the answers into the requirements.
              </template>
              <template v-else> Resolve or dismiss all items to enable. </template>
            </span>
          </div>

          <!-- incorporated result -->
          <div
            v-if="review.incorporatedRequirements"
            class="rounded-lg border border-slate-800 bg-slate-950/40 p-3"
          >
            <div class="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
              Updated requirements
            </div>
            <p class="whitespace-pre-line text-sm text-slate-300">
              {{ review.incorporatedRequirements }}
            </p>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
