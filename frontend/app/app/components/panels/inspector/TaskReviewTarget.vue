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
import { computed } from 'vue'
import type { Block } from '~/types/domain'
import InspectorSection from '~/components/panels/inspector/InspectorSection.vue'

const props = defineProps<{ block: Block }>()
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

/** Nothing to show when the task carries no reference at all (nothing to link or name). */
const hasTarget = computed(() => Boolean(label.value))
</script>

<template>
  <InspectorSection
    v-if="isReview && hasTarget"
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
      v-else
      class="rounded-lg border border-slate-800 bg-slate-900/40 p-2.5 text-xs text-slate-300"
      data-testid="inspector-review-target-link"
    >
      {{ label }}
    </p>
    <p v-if="focus" class="text-xs leading-relaxed text-slate-500">
      {{ t('inspector.reviewTarget.focus', { focus }) }}
    </p>
  </InspectorSection>
</template>
