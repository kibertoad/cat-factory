<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Project, ProjectBoardView } from '@cat-factory/contracts'
import EmptyState from '~/components/common/EmptyState.vue'
import MarkdownProse from '~/components/common/MarkdownProse.vue'
import SectionLabel from '~/components/common/SectionLabel.vue'
import ResearchFindingItem from '~/components/research/ResearchFindingItem.vue'
import ResearchFollowUpModal from '~/components/research/ResearchFollowUpModal.vue'
import { readerTopics, researchReadingOf } from '~/utils/research'

// The research kind's reader, contributed to the project takeover's `projectViews` slot: coverage
// per topic, every question with its current answer and evidence, run-level learnings, and the
// follow-up that starts the next research task. The takeover owns what every kind shares.

const props = defineProps<{ project: Project; board: ProjectBoardView }>()
const { t } = useI18n()

const reading = computed(() => researchReadingOf(props.board))
const followUpOpen = ref(false)
const grouped = computed(() => (reading.value ? readerTopics(reading.value) : null))
const countsByTopic = computed(
  () =>
    new Map(
      (reading.value?.view.coverage.byTopic ?? []).map((entry) => [entry.topicId, entry.counts]),
    ),
)
const total = computed(() => reading.value?.view.coverage.total)
</script>

<template>
  <EmptyState
    v-if="!reading || !grouped"
    icon="i-lucide-telescope"
    :title="t('research.unavailable')"
    compact
  />
  <div v-else class="space-y-5" data-testid="research-findings">
    <div class="flex flex-wrap items-center gap-2">
      <p v-if="total" class="flex flex-wrap gap-2 text-xs" data-testid="research-coverage">
        <UBadge
          v-for="status in ['answered', 'partial', 'blocked', 'unanswered'] as const"
          :key="status"
          color="neutral"
          variant="subtle"
          size="sm"
        >
          {{ t(`research.coverage.${status}`, { count: total[status] }) }}
        </UBadge>
      </p>
      <UButton
        class="ms-auto"
        icon="i-lucide-plus"
        size="xs"
        data-testid="research-start-follow-up"
        @click="followUpOpen = true"
      >
        {{ t('research.followUp.open') }}
      </UButton>
    </div>
    <MarkdownProse v-if="reading.view.summary" class="text-sm" :text="reading.view.summary" />
    <section v-for="topic in grouped.topics" :key="topic.id" data-testid="research-topic">
      <SectionLabel class="mb-2">
        {{ topic.title }}
        <span class="ms-1 normal-case text-dimmed">
          {{
            t('research.topicCoverage', {
              answered: countsByTopic.get(topic.id)?.answered ?? 0,
              total: topic.questions.length,
            })
          }}
        </span>
      </SectionLabel>
      <div class="space-y-2">
        <ResearchFindingItem v-for="q in topic.questions" :key="q.id" :entry="q" />
      </div>
    </section>
    <section v-if="grouped.adhoc.length">
      <SectionLabel class="mb-2">{{ t('research.adhoc') }}</SectionLabel>
      <div class="space-y-2">
        <ResearchFindingItem v-for="q in grouped.adhoc" :key="q.id" :entry="q" />
      </div>
    </section>
    <section v-if="grouped.retired.length">
      <SectionLabel class="mb-2">{{ t('research.retired') }}</SectionLabel>
      <div class="space-y-2">
        <ResearchFindingItem v-for="q in grouped.retired" :key="q.id" :entry="q" />
      </div>
    </section>
    <section v-if="reading.view.learnings.length">
      <SectionLabel class="mb-2">{{ t('research.learnings') }}</SectionLabel>
      <ul class="space-y-2">
        <li
          v-for="(learning, i) in reading.view.learnings"
          :key="i"
          class="rounded-lg border border-default p-3"
        >
          <p class="text-sm font-medium">{{ learning.title }}</p>
          <MarkdownProse v-if="learning.detail" class="mt-1 text-sm" :text="learning.detail" />
        </li>
      </ul>
    </section>
    <ResearchFollowUpModal
      v-model:open="followUpOpen"
      :project="project"
      :reading="reading"
      :answered="board.outcomes.length > 0"
    />
  </div>
</template>
