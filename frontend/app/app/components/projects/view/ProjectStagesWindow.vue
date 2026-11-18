<script setup lang="ts">
import { computed } from 'vue'
import ProjectViewTakeover from '~/components/projects/view/ProjectViewTakeover.vue'

// The project takeover opened from outside its board node: a `stage_checkpoint` card names the
// stage's task, so this resolves the project the task sits under and opens it, on its stages.

const board = useBoardStore()
const projects = useProjectsStore()
const { blockId, close } = useResultView('project-stages')

const project = computed(() => {
  const parentId = blockId.value ? board.getBlock(blockId.value)?.parentId : undefined
  return parentId ? projects.byRootBlock[parentId] : undefined
})
const title = computed(() =>
  project.value ? (board.getBlock(project.value.rootBlockId)?.title ?? project.value.id) : '',
)
const open = computed({
  get: () => !!project.value,
  set: (value: boolean) => {
    if (!value) close()
  },
})
</script>

<template>
  <ProjectViewTakeover v-if="project" v-model:open="open" :project="project" :title="title" />
</template>
