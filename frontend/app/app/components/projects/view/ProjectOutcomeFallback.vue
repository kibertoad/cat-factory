<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Project, ProjectBoardView, ProjectOutcomeDetail } from '@cat-factory/contracts'
import EmptyState from '~/components/common/EmptyState.vue'
import SectionLabel from '~/components/common/SectionLabel.vue'

// The reader for a project kind that contributes none: the newest readable outcome of each stream,
// shown as its kind recorded it. It makes a new kind readable before anyone writes a view for it;
// the full history is on its own tab.

const props = defineProps<{ project: Project; board: ProjectBoardView }>()
const { t } = useI18n()
const projectViews = useProjectViewsStore()
const errors = usePipelineErrorToast()

/** The newest readable outcome id of each stream, streams in the order they first appear. */
const latestByStream = computed(() => {
  const latest = new Map<string, string>()
  for (const entry of props.board.outcomes) {
    if (entry.storage.readable) latest.set(entry.stream, entry.id)
  }
  return [...latest.entries()].map(([stream, id]) => ({ stream, id }))
})

const bodies = ref<Record<string, ProjectOutcomeDetail>>({})

watch(
  latestByStream,
  async (latest) => {
    const missing = latest.filter(({ id }) => !bodies.value[id])
    try {
      const read = await Promise.all(
        missing.map(({ id }) => projectViews.outcome(props.project.id, id)),
      )
      bodies.value = { ...bodies.value, ...Object.fromEntries(read.map((o) => [o.id, o])) }
    } catch (e) {
      errors.present(e, 'projects.view.outcomes.openFailed')
    }
  },
  { immediate: true },
)
</script>

<template>
  <EmptyState
    v-if="latestByStream.length === 0"
    icon="i-lucide-inbox"
    :title="t('projects.view.fallback.empty')"
    compact
  />
  <div v-else class="space-y-4" data-testid="project-view-fallback">
    <section v-for="{ stream, id } in latestByStream" :key="stream">
      <SectionLabel class="mb-2">{{ t('projects.view.fallback.stream', { stream }) }}</SectionLabel>
      <pre
        v-if="bodies[id]"
        class="max-h-[60vh] overflow-auto rounded border border-default p-3 text-xs"
        >{{ JSON.stringify(bodies[id].body, null, 2) }}</pre>
    </section>
  </div>
</template>
