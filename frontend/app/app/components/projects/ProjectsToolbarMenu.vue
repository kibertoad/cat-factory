<script setup lang="ts">
import { computed, ref } from 'vue'
import CreateProjectModal from '~/components/projects/CreateProjectModal.vue'

// The board toolbar's projects entry: create a project (when the deployment registers a kind)
// and mount one of the account's existing projects onto this board. Absent when there is
// neither, so a deployment with no project kinds shows nothing new. When the kinds could not be
// read, the menu says so rather than looking like a deployment that registers none.
const { t } = useI18n()
const projects = useProjectsStore()
const board = useBoardStore()
const access = useWorkspaceAccess()
const actionToast = useActionToast()
const { present } = usePipelineErrorToast()

const createOpen = ref(false)

async function mountProject(projectId: string, title: string) {
  try {
    await projects.mount(projectId)
    actionToast.success('projects.mount.added', { params: { title } })
  } catch (e) {
    present(e, 'projects.mount.failed')
  }
}

const createItems = computed(() => {
  if (projects.creatableKinds.length) {
    return [
      {
        label: t('projects.toolbar.newProject'),
        icon: 'i-lucide-folder-plus',
        onSelect: () => {
          createOpen.value = true
        },
      },
    ]
  }
  if (projects.kindsUnavailable) {
    return [
      { label: t('projects.toolbar.kindsUnavailable'), icon: 'i-lucide-cloud-off', disabled: true },
    ]
  }
  return []
})

const mountItems = computed(() =>
  projects.mountable.map((p) => {
    const title = board.getBlock(p.rootBlockId)?.title ?? p.id
    return {
      label: title,
      icon: 'i-lucide-folder-kanban',
      onSelect: () => {
        void mountProject(p.id, title)
      },
    }
  }),
)

const items = computed(() => [createItems.value, mountItems.value].filter((g) => g.length))
</script>

<template>
  <template v-if="items.length && access.canWriteBoard.value">
    <UDropdownMenu :items="items">
      <UButton
        color="neutral"
        variant="ghost"
        size="sm"
        icon="i-lucide-folder-kanban"
        data-testid="board-projects-menu"
      >
        <span class="hidden sm:inline">{{ t('projects.toolbar.menu') }}</span>
      </UButton>
    </UDropdownMenu>
    <CreateProjectModal v-model:open="createOpen" />
  </template>
</template>
