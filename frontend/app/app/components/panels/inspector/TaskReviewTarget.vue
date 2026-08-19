<script setup lang="ts">
// The pull request a `review` task is reviewing — its SUBJECT, not its output. Distinct from the
// Execution panel's "Pull request", which links the PR a run PRODUCED: a review task produces no
// PR at all, so without this the one thing identifying the task was buried in the folded
// description text with nothing to click.
//
// Reads the task's own fields, so it is there from creation — before any run — and stays there
// after one. The backend confirms the PR against the provider at create time and records that
// provider's own link (`prUrl`), which is what makes a plain read enough here; a task created
// while no VCS was connected keeps only the number, and then the reference reads as text rather
// than pretending to be a link.
//
// The SKILL QUEUE is editable here, and that is not a convenience. A queued skill that has left
// the catalog FAILS every dispatch of this task, and the refusal's remedy names the task's own
// queue as where the fix is made; with the queue frozen at creation that remedy pointed at
// nothing and the only exit was deleting a task whose id every stored reference holds. Same
// reasoning as `TaskTypeFields`, which exists for the same shape of dead end.
import { computed, ref, watch } from 'vue'
import type { Block } from '~/types/domain'
import InspectorSection from '~/components/panels/inspector/InspectorSection.vue'
import ReviewSkillQueue from '~/components/skills/ReviewSkillQueue.vue'

const props = defineProps<{ block: Block }>()
const board = useBoardStore()
const { t } = useI18n()

const isReview = computed(() => props.block.taskType === 'review')
const fields = computed(() => props.block.taskTypeFields ?? null)
const url = computed(() => fields.value?.prUrl?.trim() || '')
const focus = computed(() => fields.value?.reviewFocus?.trim() || '')

/** `#123` when the number is known, else the raw link — never an empty affordance. */
const label = computed(() => {
  const number = fields.value?.prNumber
  return number ? t('inspector.reviewTarget.prNumber', { number }) : url.value
})

/** The queue as STORED, the baseline the edit buffer is seeded from and compared against. */
const stored = computed<string[]>(() => fields.value?.reviewSkillIds ?? [])

// Local edit buffer, re-seeded whenever the stored queue changes underneath (a live board push,
// or switching blocks). Editing writes on commit rather than per pick, so a half-built queue
// never reaches the row a dispatch reads.
const draft = ref<string[]>([...stored.value])
watch(stored, (next) => {
  draft.value = [...next]
})

const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(stored.value))
const saving = ref(false)

/**
 * Write the queue through the BUILT-IN half of the per-type bag, which REPLACES that half whole:
 * the other built-in keys are read back off the block and sent with it, so editing the queue can
 * never clear the pull request this task reviews. The `custom` half is a separate request key and
 * is left alone by construction.
 */
async function save() {
  if (!dirty.value) return
  const { custom: _custom, ...builtin } = props.block.taskTypeFields ?? {}
  saving.value = true
  try {
    await board.updateBlock(props.block.id, {
      builtinTaskTypeFields: {
        ...builtin,
        ...(draft.value.length ? { reviewSkillIds: [...draft.value] } : {}),
      },
    })
  } finally {
    saving.value = false
  }
}

function revert() {
  draft.value = [...stored.value]
}
</script>

<template>
  <InspectorSection
    v-if="isReview"
    :title="t('inspector.reviewTarget.title')"
    :hint="t('inspector.reviewTarget.hint')"
    icon="i-lucide-git-pull-request-arrow"
    default-open
  >
    <UButton
      v-if="url"
      :to="url"
      target="_blank"
      rel="noopener"
      external
      color="neutral"
      variant="soft"
      size="sm"
      icon="i-lucide-git-pull-request"
      trailing-icon="i-lucide-external-link"
      block
      data-testid="inspector-review-target-link"
    >
      <span class="w-full truncate text-start" :title="url">{{ label }}</span>
    </UButton>
    <p
      v-else-if="label"
      class="rounded-lg border border-slate-800 bg-slate-900/40 p-2.5 text-xs text-slate-300"
      data-testid="inspector-review-target-link"
    >
      {{ label }}
    </p>
    <p v-if="focus" class="text-xs leading-relaxed text-slate-500">
      {{ t('inspector.reviewTarget.focus', { focus }) }}
    </p>
    <div data-testid="inspector-review-skills">
      <ReviewSkillQueue v-model="draft" />
      <div v-if="dirty" class="mt-2 flex items-center gap-2">
        <UButton
          size="xs"
          color="primary"
          variant="soft"
          :loading="saving"
          data-testid="inspector-review-skills-save"
          @click="save"
        >
          {{ t('skills.reviewQueue.save') }}
        </UButton>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          data-testid="inspector-review-skills-revert"
          @click="revert"
        >
          {{ t('skills.reviewQueue.revert') }}
        </UButton>
      </div>
    </div>
  </InspectorSection>
</template>
