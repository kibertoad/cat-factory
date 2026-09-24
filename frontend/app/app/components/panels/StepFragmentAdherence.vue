<script setup lang="ts">
// A code/PR review step's best-practice adherence report, surfaced in run details: for each
// best-practice standard (prompt fragment) folded into the reviewer's prompt, how well the reviewed
// change adheres (1..10) and the issues that standard surfaced. Recorded on the step
// (`step.fragmentAdherence`) by the engine from the review agent's output. Rendered only when the
// reviewer reported at least one standard; when none were reachable the reviewer says so in its
// summary instead (so there is nothing to show here).
import type { FragmentAdherence } from '~/types/execution'
import MarkdownProse from '~/components/common/MarkdownProse.vue'

const props = defineProps<{ items: FragmentAdherence }>()
const { t } = useI18n()

/** Rating band → bar colour: poor adherence (rose) → partial (amber) → strong (emerald). */
function ratingClass(rating: number): string {
  return rating >= 8
    ? 'bg-app-success-400'
    : rating >= 5
      ? 'bg-app-warning-400'
      : 'bg-app-error-400'
}
function ratingPct(rating: number): number {
  return Math.min(100, Math.max(0, (rating / 10) * 100))
}
/** The label the reviewer was asked to cite the standard by: its title, else its id. */
function label(item: FragmentAdherence[number]): string {
  return item.title?.trim() || item.fragmentId || t('panels.stepDetail.adherence.unnamed')
}
</script>

<template>
  <section
    v-if="items.length"
    data-testid="step-fragment-adherence"
    class="scroll-mt-4 rounded-xl border border-default bg-default/50 p-4"
  >
    <div
      class="mb-2 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-muted"
    >
      <UIcon name="i-lucide-clipboard-check" class="h-3.5 w-3.5" />
      <span :title="t('panels.stepDetail.adherence.headingHint')">
        {{ t('panels.stepDetail.adherence.heading') }}
      </span>
    </div>

    <div class="space-y-2.5">
      <article
        v-for="(item, i) in items"
        :key="item.fragmentId ?? i"
        data-testid="step-fragment-adherence-item"
        class="rounded-lg border border-default bg-default/60 px-3 py-2"
      >
        <div class="flex items-center gap-2">
          <span class="min-w-0 flex-1 truncate text-sm font-medium text-app-100">{{
            label(item)
          }}</span>
          <div class="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-accented/60">
            <div
              class="h-full rounded-full"
              :class="ratingClass(item.rating)"
              :style="{ width: `${ratingPct(item.rating)}%` }"
            />
          </div>
          <span
            class="shrink-0 text-xs font-medium text-default"
            :title="t('panels.stepDetail.adherence.ratingHint')"
          >
            {{ t('panels.stepDetail.adherence.outOfTen', { value: item.rating }) }}
          </span>
        </div>
        <MarkdownProse
          v-if="item.assessment"
          :text="item.assessment"
          class="mt-1 text-xs leading-relaxed text-toned"
        />
        <div v-if="item.relatedFindings.length" class="mt-1.5">
          <p class="text-3xs font-semibold uppercase tracking-wide text-dimmed">
            {{ t('panels.stepDetail.adherence.relatedFindings') }}
          </p>
          <ul class="mt-0.5 space-y-0.5">
            <li
              v-for="(finding, fi) in item.relatedFindings"
              :key="fi"
              class="flex items-start gap-1.5 text-2xs text-muted"
            >
              <UIcon name="i-lucide-dot" class="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{{ finding }}</span>
            </li>
          </ul>
        </div>
      </article>
    </div>
  </section>
</template>
