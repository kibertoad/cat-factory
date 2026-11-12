<script setup lang="ts">
import { computed, ref } from 'vue'
import IconButton from '~/components/common/IconButton.vue'

// Projects to link to a task that does not exist yet: staged here, linked once the create
// succeeds (`useStagedProjectLinks`). Offers the same projects the task inspector does.
const staged = defineModel<string[]>({ required: true })

const { t } = useI18n()
const projects = useProjectsStore()
const board = useBoardStore()
const picked = ref<string | undefined>(undefined)

const titleOf = (projectId: string) => {
  const project = projects.catalog.find((p) => p.id === projectId)
  return (project && board.getBlock(project.rootBlockId)?.title) ?? projectId
}

const options = computed(() =>
  projects.catalog
    .filter((p) => !staged.value.includes(p.id))
    .map((p) => ({ label: titleOf(p.id), value: p.id })),
)

function stage() {
  if (!picked.value) return
  staged.value = [...staged.value, picked.value]
  picked.value = undefined
}
</script>

<template>
  <UFormField
    v-if="options.length || staged.length"
    :label="t('projects.taskLinks.title')"
    :hint="t('projects.taskLinks.stageHint')"
    data-testid="add-task-projects"
  >
    <div class="space-y-1.5">
      <div v-if="options.length" class="flex items-center gap-2">
        <USelectMenu
          v-model="picked"
          :items="options"
          value-key="value"
          :placeholder="t('projects.taskLinks.pick')"
          class="min-w-0 flex-1"
          size="sm"
          data-testid="add-task-projects-select"
        />
        <UButton size="sm" icon="i-lucide-link" :disabled="!picked" @click="stage">
          {{ t('projects.taskLinks.link') }}
        </UButton>
      </div>
      <div
        v-for="projectId in staged"
        :key="projectId"
        class="flex items-center gap-1.5 rounded-md border border-default bg-default/60 px-2 py-1.5 text-xs"
      >
        <UIcon name="i-lucide-folder-search" class="h-3.5 w-3.5 shrink-0 text-primary" />
        <span class="min-w-0 flex-1 truncate">{{ titleOf(projectId) }}</span>
        <IconButton
          icon="i-lucide-x"
          :label="t('projects.taskLinks.unlink')"
          size="xs"
          @click="staged = staged.filter((id) => id !== projectId)"
        />
      </div>
    </div>
  </UFormField>
</template>
