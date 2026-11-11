<script setup lang="ts">
import { ref } from 'vue'
import type { Project, ProjectOutcomeDetail, ProjectOutcomeEntry } from '@cat-factory/contracts'
import EmptyState from '~/components/common/EmptyState.vue'
import { formatBytes, outcomeStorageState } from '~/utils/projectView'
import type { BadgeColor } from '~/utils/badge'

// Every outcome the project's tasks wrote, newest first: which task wrote it, its stream and what
// it asked for in its kind's vocabulary, its sequence number, and where its body lives with its
// size. An offloaded body that cannot be read is named as unavailable, so a missing outcome never
// reads like a small one. An opened body is shown as its kind recorded it.

const props = defineProps<{ project: Project; outcomes: ProjectOutcomeEntry[] }>()
const { t, d } = useI18n()
const projectViews = useProjectViewsStore()
const errors = usePipelineErrorToast()
const blocks = useBoardStore()

const STORAGE_COLOR: Record<'inline' | 'offloaded' | 'unavailable', BadgeColor> = {
  inline: 'neutral',
  offloaded: 'info',
  unavailable: 'error',
}

const opened = ref<ProjectOutcomeDetail | null>(null)
const openingId = ref<string | null>(null)

async function open(entry: ProjectOutcomeEntry) {
  if (opened.value?.id === entry.id) {
    opened.value = null
    return
  }
  openingId.value = entry.id
  try {
    opened.value = await projectViews.outcome(props.project.id, entry.id)
  } catch (e) {
    errors.present(e, 'projects.view.outcomes.openFailed')
  } finally {
    openingId.value = null
  }
}

function writtenBy(entry: ProjectOutcomeEntry): string {
  const task = entry.taskId ? (blocks.getBlock(entry.taskId)?.title ?? entry.taskId) : '-'
  return entry.definitionVersion === null
    ? t('projects.view.outcomes.taskOnly', { task })
    : t('projects.view.outcomes.task', { task, version: entry.definitionVersion })
}
</script>

<template>
  <EmptyState
    v-if="outcomes.length === 0"
    icon="i-lucide-history"
    :title="t('projects.view.outcomes.empty')"
    compact
  />
  <ul v-else class="space-y-2" data-testid="project-outcomes">
    <li
      v-for="entry in [...outcomes].reverse()"
      :key="entry.id"
      class="rounded-lg border border-default p-3"
      data-testid="project-outcome"
    >
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-sm font-medium text-highlighted">
          {{ t('projects.view.outcomes.seq', { seq: entry.seq }) }}
        </span>
        <UBadge color="neutral" variant="subtle" size="sm" class="font-mono">
          {{ entry.stream }} / {{ entry.intent }}
        </UBadge>
        <UBadge
          :color="STORAGE_COLOR[outcomeStorageState(entry.storage)]"
          variant="subtle"
          size="sm"
          data-testid="project-outcome-storage"
        >
          {{
            t(`projects.view.outcomes.storage.${outcomeStorageState(entry.storage)}`, {
              size: formatBytes(entry.storage.bytes),
            })
          }}
        </UBadge>
        <span class="text-xs text-dimmed">{{ d(new Date(entry.createdAt), 'short') }}</span>
        <UButton
          class="ms-auto"
          size="xs"
          color="neutral"
          variant="ghost"
          :loading="openingId === entry.id"
          :disabled="!entry.storage.readable"
          @click="open(entry)"
        >
          {{
            opened?.id === entry.id
              ? t('projects.view.outcomes.hide')
              : t('projects.view.outcomes.show')
          }}
        </UButton>
      </div>
      <p class="mt-1 text-xs text-muted">{{ writtenBy(entry) }}</p>
      <pre
        v-if="opened?.id === entry.id"
        class="mt-2 max-h-96 overflow-auto rounded border border-default p-2 text-xs"
        data-testid="project-outcome-body"
        >{{ JSON.stringify(opened.body, null, 2) }}</pre>
    </li>
  </ul>
</template>
