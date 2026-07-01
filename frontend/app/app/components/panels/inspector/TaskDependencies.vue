<script setup lang="ts">
import type { Block } from '~/types/domain'
import EmptyState from '~/components/common/EmptyState.vue'

const props = defineProps<{ block: Block }>()

const board = useBoardStore()
const { depLabel } = useDepLabels()
const { confirm } = useConfirm()
const { t } = useI18n()

const deps = computed(() =>
  (props.block.dependsOn ?? []).map((id) => board.getBlock(id)).filter((b): b is Block => !!b),
)
const runnable = computed(() => board.isRunnable(props.block.id))

/** Label a dependency relative to this task's container. */
const label = (dep: Block) => depLabel(dep, props.block.parentId)

// candidate tasks to depend on: any other task not already a dependency
const depMenu = computed(() => {
  const current = new Set(props.block.dependsOn)
  return board.allTasks
    .filter((t) => t.id !== props.block.id && !current.has(t.id))
    .map((t) => ({
      label: label(t),
      icon: 'i-lucide-plus',
      onSelect: () => board.toggleDependency(props.block.id, t.id),
    }))
})

async function removeDep(dep: Block) {
  const ok = await confirm({
    title: t('inspector.dependencies.confirmRemove.title'),
    description: t('inspector.dependencies.confirmRemove.body', { name: label(dep) }),
    variant: 'destructive',
    confirmLabel: t('common.remove'),
    icon: 'i-lucide-unlink',
  })
  if (ok) board.removeDependency(props.block.id, dep.id)
}
</script>

<template>
  <div>
    <div class="mb-1 flex items-center justify-between">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {{ t('inspector.dependencies.title') }}
      </span>
      <UDropdownMenu v-if="depMenu.length" :items="depMenu">
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          icon="i-lucide-plus"
          trailing-icon="i-lucide-chevron-down"
        />
      </UDropdownMenu>
    </div>
    <div v-if="deps.length" class="flex flex-wrap gap-1">
      <UBadge
        v-for="d in deps"
        :key="d.id"
        :color="d.status === 'done' ? 'neutral' : 'warning'"
        variant="subtle"
        size="sm"
        class="cursor-pointer"
        :title="
          d.status === 'done'
            ? t('inspector.dependencies.merged')
            : t('inspector.dependencies.notMerged')
        "
        @click="removeDep(d)"
      >
        {{ label(d) }}
        <UIcon name="i-lucide-x" class="ms-0.5 h-3 w-3" />
      </UBadge>
    </div>
    <EmptyState
      v-else
      compact
      icon="i-lucide-git-branch"
      :title="t('inspector.dependencies.empty')"
    />
    <div v-if="!runnable" class="mt-1 text-[10px] text-amber-400">
      {{ t('inspector.dependencies.blocked') }}
    </div>
  </div>
</template>
