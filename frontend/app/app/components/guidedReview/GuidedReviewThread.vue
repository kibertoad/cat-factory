<script setup lang="ts">
// One exploration thread: its messages, the comment drafts it produced, and a composer. While its
// own answer is pending the composer waits; other threads are unaffected.
import type { GuidedReviewCommentDraft, GuidedReviewThreadView } from '~/types/domain'
import MarkdownProse from '~/components/common/MarkdownProse.vue'
import GuidedReviewFailure from '~/components/guidedReview/GuidedReviewFailure.vue'
import {
  canAsk,
  citationLabel,
  draftAnchor,
  droppedAnchor,
  isLive,
  keptDrafts,
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
        <div v-for="d in drafts" :key="d.id" class="rounded-md border border-default p-2 text-sm">
          <p class="text-xs text-dimmed">
            {{ draftAnchor(d) }}
            ({{ t(`guidedReview.drafts.side.${d.side}`) }})
          </p>
          <MarkdownProse :text="d.body" />
          <p v-if="d.rationale" class="mt-1 text-xs text-muted">{{ d.rationale }}</p>
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
