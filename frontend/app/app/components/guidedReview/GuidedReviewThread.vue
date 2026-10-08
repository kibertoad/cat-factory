<script setup lang="ts">
// One exploration thread: its messages, the comment drafts it produced, and a composer. While its
// own answer is pending the composer waits; other threads are unaffected.
import { isPostableDraft } from '@cat-factory/contracts'
import type { GuidedReviewCommentDraft, GuidedReviewThreadView } from '~/types/domain'
import MarkdownProse from '~/components/common/MarkdownProse.vue'
import GuidedReviewFailure from '~/components/guidedReview/GuidedReviewFailure.vue'
import GuidedReviewDraftCard from '~/components/guidedReview/GuidedReviewDraftCard.vue'
import {
  canAsk,
  citationLabel,
  droppedAnchor,
  isLive,
  keptDrafts,
  postableSelection,
} from '~/components/guidedReview/GuidedReview.logic'

const props = defineProps<{
  sessionId: string
  /** Absent for the unsaved new-thread tab: its first question creates the thread. */
  view: GuidedReviewThreadView | undefined
  drafts: GuidedReviewCommentDraft[]
}>()
const emit = defineEmits<{ created: [threadId: string] }>()
const { t } = useI18n()
const store = useGuidedReviewStore()
const { present } = usePipelineErrorToast()

const prompt = ref('')
const sending = ref(false)
const messages = computed(() => props.view?.messages ?? [])
const ready = computed(() => canAsk(messages.value) && !sending.value)
const canSend = computed(() => ready.value && prompt.value.trim().length > 0)

async function send(): Promise<void> {
  if (!canSend.value) return
  const content = prompt.value.trim()
  sending.value = true
  try {
    if (props.view) {
      await store.ask(props.sessionId, props.view.thread.id, { content })
    } else {
      const created = await store.openThread(props.sessionId, { question: { content } })
      emit('created', created.thread.id)
    }
    prompt.value = ''
  } catch (error) {
    present(error, 'guidedReview.errors.ask')
  } finally {
    sending.value = false
  }
}

const selected = ref(new Set<string>())
const summary = ref('')
const posting = ref(false)
const postResult = ref<{
  posted: number
  failed: number
  skipped: number
  summaryError: string | null
} | null>(null)
// A `posting` draft becomes postable again once its claim outlives the lease, so the clock only
// runs while one is on screen.
const now = useNowTick(30_000, () => props.drafts.some((d) => d.status === 'posting'))
const toPost = computed(() => postableSelection(props.drafts, selected.value, now.value))

function setSelected(id: string, value: boolean): void {
  const next = new Set(selected.value)
  if (value) next.add(id)
  else next.delete(id)
  selected.value = next
}

async function post(): Promise<void> {
  if (!toPost.value.length) return
  posting.value = true
  try {
    const result = await store.postDrafts(props.sessionId, toPost.value, summary.value)
    const summaryFailed = result.summary.posted === false
    postResult.value = {
      posted: result.posted,
      failed: result.failed,
      skipped: result.skipped.length,
      summaryError: summaryFailed ? (result.summary.error ?? '') : null,
    }
    selected.value = new Set()
    // A summary the host refused stays in the box, so the reviewer can post it with a retry.
    if (!summaryFailed) summary.value = ''
  } catch (error) {
    present(error, 'guidedReview.errors.postDrafts')
  } finally {
    posting.value = false
  }
}

async function draftComments(): Promise<void> {
  if (!props.view || !ready.value) return
  sending.value = true
  try {
    await store.requestDrafts(props.sessionId, props.view.thread.id)
  } catch (error) {
    present(error, 'guidedReview.errors.drafts')
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-3" data-testid="guided-review-thread">
    <div class="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
      <p v-if="!messages.length" class="text-sm text-muted">
        {{ t('guidedReview.thread.empty') }}
      </p>
      <div
        v-for="m in messages"
        :key="m.id"
        :class="m.role === 'user' ? 'ms-8 bg-elevated' : 'me-8 border border-default'"
        class="rounded-lg p-3 text-sm"
        :data-testid="`guided-review-message-${m.role}`"
      >
        <template v-if="m.role === 'user'">
          <p v-if="m.kind === 'comment-drafts'" class="text-xs text-dimmed">
            {{ t('guidedReview.thread.draftRequest') }}
          </p>
          <p class="whitespace-pre-wrap">{{ m.content }}</p>
        </template>
        <p v-else-if="isLive(m)" class="flex items-center gap-2 text-muted">
          <UIcon name="i-lucide-loader-circle" class="h-4 w-4 animate-spin" />
          {{ t('guidedReview.thread.waiting') }}
        </p>
        <GuidedReviewFailure v-else-if="m.status === 'failed' && m.failure" :failure="m.failure" />
        <template v-else-if="m.kind === 'answer'">
          <MarkdownProse :text="m.content" />
          <div v-if="m.citations.length" class="mt-2 flex flex-wrap gap-1">
            <UBadge
              v-for="(c, i) in m.citations"
              :key="i"
              size="sm"
              variant="outline"
              color="neutral"
            >
              {{ citationLabel(c) }}
            </UBadge>
          </div>
        </template>
        <template v-else>
          <p>
            {{
              t('guidedReview.drafts.summary', {
                kept: keptDrafts(drafts, m.id),
                proposed: m.draftReport?.proposed ?? 0,
              })
            }}
          </p>
          <ul v-if="m.draftReport?.dropped.length" class="mt-1 space-y-0.5 text-xs text-muted">
            <li
              v-for="(d, i) in m.draftReport.dropped"
              :key="i"
              data-testid="guided-review-dropped"
            >
              {{ droppedAnchor(d) }}:
              {{ t(`guidedReview.dropped.${d.reason}`) }}
            </li>
          </ul>
        </template>
      </div>

      <div v-if="drafts.length" class="space-y-2" data-testid="guided-review-drafts">
        <h4 class="text-xs font-semibold uppercase text-dimmed">
          {{ t('guidedReview.drafts.title') }}
        </h4>
        <GuidedReviewDraftCard
          v-for="d in drafts"
          :key="d.id"
          :session-id="sessionId"
          :draft="d"
          :selected="selected.has(d.id)"
          :postable="isPostableDraft(d, now)"
          @update:selected="setSelected(d.id, $event)"
        />
        <div class="space-y-2 rounded-md bg-elevated p-2" data-testid="guided-review-post">
          <UTextarea
            v-model="summary"
            :rows="2"
            autoresize
            class="w-full"
            :placeholder="t('guidedReview.drafts.summaryPlaceholder')"
          />
          <div class="flex flex-wrap items-center gap-2">
            <UButton
              color="primary"
              icon="i-lucide-upload"
              :loading="posting"
              :disabled="!toPost.length"
              data-testid="guided-review-post-drafts"
              @click="post"
            >
              {{ t('guidedReview.drafts.post', { count: toPost.length }) }}
            </UButton>
            <p v-if="postResult" class="text-xs text-muted" data-testid="guided-review-post-result">
              {{ t('guidedReview.drafts.postResult', postResult) }}
            </p>
            <p
              v-if="postResult && postResult.summaryError !== null"
              class="text-xs text-error"
              data-testid="guided-review-post-summary-error"
            >
              {{ t('guidedReview.drafts.summaryFailed') }}: {{ postResult.summaryError }}
            </p>
          </div>
        </div>
      </div>
    </div>

    <div class="space-y-2">
      <UTextarea
        v-model="prompt"
        :rows="3"
        autoresize
        :maxrows="10"
        class="w-full"
        :disabled="!ready"
        :placeholder="ready ? t('guidedReview.thread.placeholder') : t('guidedReview.thread.busy')"
        data-testid="guided-review-composer"
        @keydown.enter.meta.prevent="send"
        @keydown.enter.ctrl.prevent="send"
      />
      <div class="flex flex-wrap items-center gap-2">
        <UButton
          color="primary"
          icon="i-lucide-send"
          :loading="sending"
          :disabled="!canSend"
          data-testid="guided-review-send"
          @click="send"
        >
          {{ t('guidedReview.thread.send') }}
        </UButton>
        <UButton
          v-if="view"
          variant="soft"
          icon="i-lucide-message-square-plus"
          :disabled="!ready || !messages.length"
          data-testid="guided-review-draft-comments"
          @click="draftComments"
        >
          {{ t('guidedReview.drafts.request') }}
        </UButton>
      </div>
    </div>
  </div>
</template>
