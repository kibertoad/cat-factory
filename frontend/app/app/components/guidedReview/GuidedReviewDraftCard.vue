<script setup lang="ts">
// One comment draft: its anchor, body and rationale, with selection for posting and an inline
// editor. Only a `proposed` or `failed` draft is editable, though a `posting` one whose poster died
// can be selected for posting again; the server refuses a stale edit as
// `draft_conflict` and a line outside the diff, both reported through the error funnel.
import type { GuidedReviewCommentDraft } from '~/types/domain'
import MarkdownProse from '~/components/common/MarkdownProse.vue'
import {
  draftAnchor,
  draftEdit,
  isEditableDraft,
} from '~/components/guidedReview/GuidedReview.logic'

const props = defineProps<{
  sessionId: string
  draft: GuidedReviewCommentDraft
  selected: boolean
  /** Whether a post may claim this draft now, including a stranded `posting` one. */
  postable: boolean
}>()
const emit = defineEmits<{ 'update:selected': [value: boolean] }>()
const { t } = useI18n()
const store = useGuidedReviewStore()
const { present } = usePipelineErrorToast()

const editing = ref(false)
const saving = ref(false)
const form = reactive({ body: '', line: 1, side: 'RIGHT' as 'LEFT' | 'RIGHT' })
const editable = computed(() => isEditableDraft(props.draft))
const STATUS_COLOR = {
  proposed: 'neutral',
  posting: 'info',
  posted: 'success',
  failed: 'error',
  discarded: 'neutral',
} as const

function startEdit(): void {
  form.body = props.draft.body
  form.line = props.draft.line
  form.side = props.draft.side
  editing.value = true
}

async function save(): Promise<void> {
  const changes = draftEdit(props.draft, form)
  if (Object.keys(changes).length === 0) {
    editing.value = false
    return
  }
  saving.value = true
  try {
    await store.editDraft(props.sessionId, props.draft.id, { rev: props.draft.rev, ...changes })
    editing.value = false
  } catch (error) {
    present(error, 'guidedReview.errors.editDraft')
  } finally {
    saving.value = false
  }
}

async function discard(): Promise<void> {
  saving.value = true
  try {
    await store.editDraft(props.sessionId, props.draft.id, { rev: props.draft.rev, discard: true })
    emit('update:selected', false)
  } catch (error) {
    present(error, 'guidedReview.errors.editDraft')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div
    class="rounded-md border border-default p-2 text-sm"
    :class="{ 'opacity-60': draft.status === 'discarded' }"
    data-testid="guided-review-draft"
  >
    <div class="flex items-center gap-2">
      <UCheckbox
        v-if="postable"
        :model-value="selected"
        :aria-label="t('guidedReview.drafts.select')"
        @update:model-value="emit('update:selected', $event === true)"
      />
      <p class="flex-1 text-xs text-dimmed">
        {{ draftAnchor(draft) }} ({{ t(`guidedReview.drafts.side.${draft.side}`) }})
      </p>
      <UBadge size="sm" variant="subtle" :color="STATUS_COLOR[draft.status]">
        {{ t(`guidedReview.drafts.status.${draft.status}`) }}
      </UBadge>
    </div>

    <div v-if="editing" class="mt-2 space-y-2">
      <UTextarea v-model="form.body" :rows="3" autoresize class="w-full" />
      <div class="flex flex-wrap items-center gap-2">
        <UInputNumber
          v-model="form.line"
          :min="1"
          size="sm"
          :aria-label="t('guidedReview.drafts.line')"
        />
        <USelect
          v-model="form.side"
          size="sm"
          :items="[
            { label: t('guidedReview.drafts.side.RIGHT'), value: 'RIGHT' },
            { label: t('guidedReview.drafts.side.LEFT'), value: 'LEFT' },
          ]"
          :aria-label="t('guidedReview.drafts.sideLabel')"
        />
        <UButton size="sm" color="primary" :loading="saving" @click="save">
          {{ t('guidedReview.drafts.save') }}
        </UButton>
        <UButton size="sm" variant="ghost" :disabled="saving" @click="editing = false">
          {{ t('guidedReview.drafts.cancel') }}
        </UButton>
      </div>
    </div>
    <template v-else>
      <MarkdownProse class="mt-1" :text="draft.body" />
      <p v-if="draft.rationale" class="mt-1 text-xs text-muted">{{ draft.rationale }}</p>
      <p v-if="draft.status === 'failed' && draft.postError" class="mt-1 text-xs text-error">
        {{ t('guidedReview.drafts.postFailed') }}: {{ draft.postError }}
      </p>
      <div v-if="editable" class="mt-2 flex gap-2">
        <UButton size="xs" variant="ghost" icon="i-lucide-pencil" @click="startEdit">
          {{ t('guidedReview.drafts.edit') }}
        </UButton>
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          icon="i-lucide-trash-2"
          :loading="saving"
          @click="discard"
        >
          {{ t('guidedReview.drafts.discard') }}
        </UButton>
      </div>
    </template>
  </div>
</template>
