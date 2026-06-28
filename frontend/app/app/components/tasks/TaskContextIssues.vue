<script setup lang="ts">
// Inspector section for a task block: the tracker issues (Jira, …) attached to
// it as agent context, plus an "Attach" menu to link an already-imported issue
// or open the import modal. Mirrors TaskContextDocs.vue; shown only when the
// task-source integration is available. Each linked issue shows its status so
// the structured nature of an issue is visible at a glance.
import type { DropdownMenuItem } from '@nuxt/ui'
import type { Block, TaskSourceKind } from '~/types/domain'

const props = defineProps<{ block: Block }>()

const { t } = useI18n()
const tasks = useTasksStore()
const ui = useUiStore()
const toast = useToast()

onMounted(() => {
  tasks.loadTasks().catch(() => {})
})

const linked = computed(() => tasks.tasksForBlock(props.block.id))

async function attach(source: TaskSourceKind, externalId: string) {
  try {
    await tasks.linkToBlock(props.block.id, source, externalId)
    toast.add({ title: t('tasks.contextIssues.attached'), icon: 'i-lucide-link' })
  } catch (e) {
    toast.add({
      title: t('tasks.contextIssues.attachFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  }
}

const attachMenu = computed<DropdownMenuItem[][]>(() => {
  const linkedKeys = new Set(linked.value.map((t) => `${t.source}:${t.externalId}`))
  const items: DropdownMenuItem[] = tasks.tasks
    .filter((t) => !linkedKeys.has(`${t.source}:${t.externalId}`))
    .map((t) => ({
      label: `${t.externalId} · ${t.title}`,
      icon: tasks.descriptorFor(t.source)?.icon ?? 'i-lucide-square-check',
      onSelect: () => attach(t.source, t.externalId),
    }))
  items.push({
    label: t('tasks.contextIssues.importIssue'),
    icon: 'i-lucide-file-down',
    onSelect: () => ui.openTaskImport(),
  })
  return [items]
})
</script>

<template>
  <div v-if="tasks.available" class="space-y-2">
    <div class="flex items-center justify-between">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {{ t('tasks.contextIssues.title') }}
      </span>
      <UDropdownMenu :items="attachMenu" :content="{ side: 'bottom', align: 'end' }">
        <UButton color="neutral" variant="soft" size="xs" icon="i-lucide-plus">{{
          t('tasks.contextIssues.attach')
        }}</UButton>
      </UDropdownMenu>
    </div>

    <div v-if="linked.length" class="space-y-1">
      <a
        v-for="task in linked"
        :key="`${task.source}:${task.externalId}`"
        :href="task.url"
        target="_blank"
        rel="noopener"
        class="flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800/60"
      >
        <UIcon
          :name="tasks.descriptorFor(task.source)?.icon ?? 'i-lucide-square-check'"
          class="h-3.5 w-3.5 shrink-0 text-indigo-400"
        />
        <span class="truncate">{{ task.externalId }} · {{ task.title }}</span>
        <UBadge color="neutral" variant="soft" size="xs" class="ml-auto shrink-0">
          {{ task.status }}
        </UBadge>
      </a>
    </div>
    <p v-else class="text-[11px] text-slate-500">
      {{ t('tasks.contextIssues.emptyHint') }}
    </p>
  </div>
</template>
