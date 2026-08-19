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
import { useSkillsStore } from '~/stores/skills'

const props = defineProps<{ block: Block }>()
const { t } = useI18n()

const isReview = computed(() => props.block.taskType === 'review')
const fields = computed(() => props.block.taskTypeFields ?? null)
const url = computed(() => fields.value?.prUrl?.trim() || '')
const focus = computed(() => fields.value?.reviewFocus?.trim() || '')

/**
 * The review playbooks this task queued, in the order the reviewer applies them. Named from the
 * snapshot catalog; an id the catalog no longer resolves still renders (as its raw id) rather
 * than vanishing, because the run will FAIL on that id and the task is where it gets fixed.
 */
const skills = useSkillsStore()
const queuedSkills = computed(() =>
  (fields.value?.reviewSkillIds ?? []).map(
    (id) => skills.catalog.find((s) => s.id === id) ?? { id, name: id, description: '' },
  ),
)

/** `#123` when the number is known, else the raw link — never an empty affordance. */
const label = computed(() => {
  const number = fields.value?.prNumber
  return number ? t('inspector.reviewTarget.prNumber', { number }) : url.value
})

/**
 * Nothing to show when the task names no pull request AND queued nothing: there would be neither
 * a link nor a lens to report. A task with a queue but no resolvable reference still renders, so
 * what the review will apply stays visible.
 */
const hasTarget = computed(() => Boolean(label.value) || queuedSkills.value.length > 0)
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
      v-else-if="label"
      class="rounded-lg border border-slate-800 bg-slate-900/40 p-2.5 text-xs text-slate-300"
      data-testid="inspector-review-target-link"
    >
      {{ label }}
    </p>
    <p v-if="focus" class="text-xs leading-relaxed text-slate-500">
      {{ t('inspector.reviewTarget.focus', { focus }) }}
    </p>
    <div v-if="queuedSkills.length" class="flex flex-col gap-1">
      <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {{ t('inspector.reviewTarget.skills') }}
      </p>
      <div class="flex flex-wrap gap-1" data-testid="inspector-review-skills">
        <UBadge
          v-for="(s, i) in queuedSkills"
          :key="s.id"
          color="primary"
          variant="subtle"
          size="sm"
          :title="s.description"
        >
          <span class="me-1 tabular-nums text-slate-400">{{ i + 1 }}</span
          >{{ s.name }}
        </UBadge>
      </div>
    </div>
  </InspectorSection>
</template>
