<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { TaskLinkedProject } from '@cat-factory/contracts'
import type { Block } from '~/types/domain'
import InspectorSection from '~/components/panels/inspector/InspectorSection.vue'
import EmptyState from '~/components/common/EmptyState.vue'
import IconButton from '~/components/common/IconButton.vue'

// Projects linked to a task as read-only context: every dispatch of the task reads each linked
// project's current result (a research project's findings). Offered from the account's projects
// whose kind keeps a result; the server refuses one with nothing to read yet, and says so.
const props = defineProps<{ block: Block }>()

const { t } = useI18n()
const projects = useProjectsStore()
const board = useBoardStore()
const actionToast = useActionToast()
const { present } = usePipelineErrorToast()

const linked = ref<TaskLinkedProject[]>([])
const picked = ref<string | undefined>(undefined)
const busy = ref(false)

const titleOf = (projectId: string, fallback: string | null) => {
  const project = projects.catalog.find((p) => p.id === projectId)
  return (project && board.getBlock(project.rootBlockId)?.title) ?? fallback ?? projectId
}

const options = computed(() => {
  const taken = new Set(linked.value.map((l) => l.projectId))
  return projects.catalog
    .filter((p) => !taken.has(p.id) && projects.kindOf(p)?.data !== undefined)
    .map((p) => ({ label: titleOf(p.id, null), value: p.id }))
})

onMounted(async () => {
  try {
    linked.value = await projects.taskLinks(props.block.id)
  } catch (e) {
    present(e, 'projects.taskLinks.loadFailed')
  }
})

async function link() {
  if (!picked.value) return
  busy.value = true
  try {
    linked.value = await projects.linkToTask(props.block.id, [picked.value])
    picked.value = undefined
    actionToast.success('projects.taskLinks.linked')
  } catch (e) {
    present(e, 'projects.taskLinks.linkFailed')
  } finally {
    busy.value = false
  }
}

async function unlink(projectId: string) {
  try {
    await projects.unlinkFromTask(props.block.id, projectId)
    linked.value = linked.value.filter((l) => l.projectId !== projectId)
  } catch (e) {
    present(e, 'projects.taskLinks.unlinkFailed')
  }
}
</script>

<template>
  <InspectorSection
    :title="t('projects.taskLinks.title')"
    :hint="t('projects.taskLinks.hint')"
    :count="linked.length"
    icon="i-lucide-folder-search"
    data-testid="task-context-projects"
  >
    <div v-if="options.length" class="flex items-center gap-2">
      <USelectMenu
        v-model="picked"
        :items="options"
        value-key="value"
        :placeholder="t('projects.taskLinks.pick')"
        class="min-w-0 flex-1"
        size="xs"
        data-testid="task-context-projects-select"
      />
      <UButton
        size="xs"
        icon="i-lucide-link"
        :loading="busy"
        :disabled="!picked"
        data-testid="task-context-projects-link"
        @click="link"
      >
        {{ t('projects.taskLinks.link') }}
      </UButton>
    </div>
    <div v-if="linked.length" class="space-y-1">
      <div
        v-for="item in linked"
        :key="item.projectId"
        class="flex items-center gap-1.5 rounded-md border border-default bg-default/60 px-2 py-1.5 text-xs"
      >
        <UIcon name="i-lucide-folder-search" class="h-3.5 w-3.5 shrink-0 text-primary" />
        <span class="min-w-0 flex-1 truncate">{{ titleOf(item.projectId, item.title) }}</span>
        <IconButton
          icon="i-lucide-x"
          :label="t('projects.taskLinks.unlink')"
          size="xs"
          @click="unlink(item.projectId)"
        />
      </div>
    </div>
    <EmptyState
      v-else
      compact
      icon="i-lucide-folder-search"
      :title="t('projects.taskLinks.empty')"
    />
  </InspectorSection>
</template>
