<script setup lang="ts">
// The structured explanation of the PR, and the status of producing it. Suggested questions are
// chips the window turns into new threads.
import type { GuidedReviewSession } from '~/types/domain'
import MarkdownProse from '~/components/common/MarkdownProse.vue'
import GuidedReviewFailure from '~/components/guidedReview/GuidedReviewFailure.vue'
import { citationLabel } from '~/components/guidedReview/GuidedReview.logic'

const props = defineProps<{
  session: GuidedReviewSession
  stale: boolean
  refreshing: boolean
  /** A suggested question is opening its thread; the chips wait so one click makes one thread. */
  asking: boolean
}>()
const emit = defineEmits<{ ask: [question: string]; refresh: [] }>()
const { t } = useI18n()

const overview = computed(() => props.session.overview)
const content = computed(() => overview.value.content)
const working = computed(
  () => overview.value.status === 'pending' || overview.value.status === 'running',
)

const SEVERITY_COLOR = { high: 'error', medium: 'warning', low: 'neutral' } as const
</script>

<template>
  <section class="space-y-4" data-testid="guided-review-overview">
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <span class="font-medium text-highlighted">
        {{ t('guidedReview.overview.title') }}
      </span>
      <UBadge v-if="stale" color="warning" variant="soft" data-testid="guided-review-stale">
        {{ t('guidedReview.overview.stale') }}
      </UBadge>
      <span class="flex-1" />
      <UButton
        color="neutral"
        size="xs"
        variant="ghost"
        icon="i-lucide-refresh-cw"
        :loading="refreshing"
        data-testid="guided-review-refresh"
        @click="emit('refresh')"
      >
        {{ t('guidedReview.overview.refresh') }}
      </UButton>
    </div>

    <p
      v-if="working"
      class="flex items-center gap-2 text-sm text-muted"
      data-testid="guided-review-overview-working"
    >
      <UIcon name="i-lucide-loader-circle" class="h-4 w-4 animate-spin" />
      {{ t('guidedReview.overview.working') }}
    </p>

    <GuidedReviewFailure
      v-else-if="overview.status === 'failed' && overview.failure"
      :failure="overview.failure"
    />

    <template v-else-if="content">
      <MarkdownProse :text="content.summary" class="text-sm" />
      <div v-if="content.intent" class="text-sm">
        <h4 class="mb-1 text-xs font-semibold uppercase text-dimmed">
          {{ t('guidedReview.overview.intent') }}
        </h4>
        <MarkdownProse :text="content.intent" />
      </div>

      <div v-if="content.meaningfulChanges.length" class="space-y-2">
        <h4 class="text-xs font-semibold uppercase text-dimmed">
          {{ t('guidedReview.overview.changes') }}
        </h4>
        <div
          v-for="(change, i) in content.meaningfulChanges"
          :key="`c${i}`"
          class="rounded-md border border-default p-2 text-sm"
        >
          <p class="font-medium">{{ change.title }}</p>
          <MarkdownProse :text="change.detail" class="text-muted" />
          <div class="mt-1 flex flex-wrap gap-1">
            <UBadge v-for="p in change.paths" :key="p" size="sm" variant="outline" color="neutral">
              {{ p }}
            </UBadge>
          </div>
        </div>
      </div>

      <div v-if="content.consequences.length" class="space-y-1">
        <h4 class="text-xs font-semibold uppercase text-dimmed">
          {{ t('guidedReview.overview.consequences') }}
        </h4>
        <div v-for="(c, i) in content.consequences" :key="`q${i}`" class="text-sm">
          <span class="font-medium">{{ c.title }}</span>
          <MarkdownProse :text="c.detail" class="text-muted" />
        </div>
      </div>

      <div v-if="content.risks.length" class="space-y-2">
        <h4 class="text-xs font-semibold uppercase text-dimmed">
          {{ t('guidedReview.overview.risks') }}
        </h4>
        <div v-for="(risk, i) in content.risks" :key="`r${i}`" class="text-sm">
          <div class="flex items-center gap-2">
            <UBadge :color="SEVERITY_COLOR[risk.severity]" variant="soft" size="sm">
              {{ t(`guidedReview.severity.${risk.severity}`) }}
            </UBadge>
            <span class="font-medium">{{ risk.title }}</span>
          </div>
          <MarkdownProse :text="risk.detail" class="text-muted" />
        </div>
      </div>

      <div v-if="content.focusAreas.length" class="space-y-2">
        <h4 class="text-xs font-semibold uppercase text-dimmed">
          {{ t('guidedReview.overview.focus') }}
        </h4>
        <div v-for="(area, i) in content.focusAreas" :key="`f${i}`" class="text-sm">
          <p class="font-medium">{{ area.title }}</p>
          <MarkdownProse :text="area.why" class="text-muted" />
          <div class="mt-1 flex flex-wrap gap-1">
            <UBadge
              v-for="(a, j) in area.anchors"
              :key="j"
              size="sm"
              variant="outline"
              color="neutral"
            >
              {{ citationLabel(a) }}
            </UBadge>
          </div>
        </div>
      </div>

      <div v-if="content.suggestedQuestions.length" class="space-y-2">
        <h4 class="text-xs font-semibold uppercase text-dimmed">
          {{ t('guidedReview.overview.suggested') }}
        </h4>
        <div class="flex flex-wrap gap-2">
          <UButton
            v-for="q in content.suggestedQuestions"
            :key="q.id"
            size="xs"
            variant="soft"
            icon="i-lucide-message-circle-question"
            class="text-start"
            :disabled="asking"
            :data-testid="`guided-review-suggested-${q.id}`"
            @click="emit('ask', q.question)"
          >
            {{ q.question }}
          </UButton>
        </div>
      </div>
    </template>
  </section>
</template>
