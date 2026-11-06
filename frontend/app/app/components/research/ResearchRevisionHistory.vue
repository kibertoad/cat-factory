<script setup lang="ts">
import { ref } from 'vue'
import type { Project, ResearchRevisionDetail, ResearchRevisionEntry } from '@cat-factory/contracts'
import MarkdownProse from '~/components/common/MarkdownProse.vue'
import EmptyState from '~/components/common/EmptyState.vue'
import { formatBytes, revisionStorageState } from '~/utils/research'
import type { BadgeColor } from '~/utils/badge'

// Every revision the project's research tasks wrote, newest first: which task wrote it, in what
// mode, its sequence number, and where its body lives with its size. An offloaded body that cannot
// be read is named as unavailable, so a missing revision never reads like a small one.

const props = defineProps<{ project: Project; revisions: ResearchRevisionEntry[] }>()
const { t, d } = useI18n()
const research = useResearchStore()
const errors = usePipelineErrorToast()
const blocks = useBoardStore()

const STORAGE_COLOR: Record<'inline' | 'offloaded' | 'unavailable', BadgeColor> = {
  inline: 'neutral',
  offloaded: 'info',
  unavailable: 'error',
}

const opened = ref<ResearchRevisionDetail | null>(null)
const openingId = ref<string | null>(null)

async function open(entry: ResearchRevisionEntry) {
  if (opened.value?.id === entry.id) {
    opened.value = null
    return
  }
  openingId.value = entry.id
  try {
    opened.value = await research.revision(props.project.id, entry.id)
  } catch (e) {
    errors.present(e, 'research.revisions.openFailed')
  } finally {
    openingId.value = null
  }
}

function taskTitle(taskId: string): string {
  return blocks.getBlock(taskId)?.title ?? taskId
}
</script>

<template>
  <EmptyState
    v-if="revisions.length === 0"
    icon="i-lucide-history"
    :title="t('research.revisions.empty')"
    compact
  />
  <ul v-else class="space-y-2" data-testid="research-revisions">
    <li
      v-for="entry in [...revisions].reverse()"
      :key="entry.id"
      class="rounded-lg border border-default p-3"
      data-testid="research-revision"
    >
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-sm font-medium text-highlighted">
          {{ t('research.revisions.seq', { seq: entry.seq }) }}
        </span>
        <UBadge color="neutral" variant="subtle" size="sm">
          {{ t(`research.mode.${entry.mode}`) }}
        </UBadge>
        <UBadge
          :color="STORAGE_COLOR[revisionStorageState(entry.storage)]"
          variant="subtle"
          size="sm"
          data-testid="research-revision-storage"
        >
          {{
            t(`research.revisions.storage.${revisionStorageState(entry.storage)}`, {
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
            opened?.id === entry.id ? t('research.revisions.hide') : t('research.revisions.show')
          }}
        </UButton>
      </div>
      <p class="mt-1 text-xs text-muted">
        {{
          t('research.revisions.task', {
            task: taskTitle(entry.taskId),
            version: entry.definitionVersion,
          })
        }}
      </p>
      <div v-if="opened?.id === entry.id" class="mt-2 border-t border-default pt-2">
        <MarkdownProse v-if="opened.body.summary" class="text-sm" :text="opened.body.summary" />
        <p class="mt-1 text-xs text-muted">
          {{ t('research.revisions.answers', { count: opened.body.findings.length }) }}
        </p>
      </div>
    </li>
  </ul>
</template>
