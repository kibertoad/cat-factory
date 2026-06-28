<script setup lang="ts">
import type { Block } from '~/types/domain'
import { STATUS_META } from '~/utils/catalog'

const props = defineProps<{ block: Block }>()

const board = useBoardStore()
const ui = useUiStore()
const { t } = useI18n()

const isFrame = computed(() => (props.block.level ?? 'frame') === 'frame')
const modules = computed(() => (isFrame.value ? board.modulesOf(props.block.id) : []))
const tasks = computed(() =>
  isFrame.value ? board.allTasksUnder(props.block.id) : board.tasksOf(props.block.id),
)

function addTask() {
  ui.openAddTask(props.block.id)
}
</script>

<template>
  <div class="space-y-4">
    <!-- modules (services only) -->
    <div v-if="modules.length">
      <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {{ t('inspector.container.modules', { count: modules.length }) }}
      </div>
      <ul class="space-y-1">
        <li
          v-for="m in modules"
          :key="m.id"
          class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-slate-800/60"
          @click="ui.select(m.id)"
        >
          <UIcon name="i-lucide-package" class="h-3.5 w-3.5 text-violet-400" />
          <span class="truncate text-xs text-slate-200">{{ m.title }}</span>
          <span class="ml-auto text-[10px] text-slate-500">{{
            t(
              'inspector.container.taskCount',
              { count: board.tasksOf(m.id).length },
              board.tasksOf(m.id).length,
            )
          }}</span>
        </li>
      </ul>
    </div>

    <div>
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {{
            isFrame
              ? t('inspector.container.allTasks', { count: tasks.length })
              : t('inspector.container.tasks', { count: tasks.length })
          }}
        </span>
        <UButton size="xs" variant="soft" color="primary" icon="i-lucide-plus" @click="addTask">
          {{ t('inspector.container.addTask') }}
        </UButton>
      </div>
      <ul v-if="tasks.length" class="space-y-1">
        <li
          v-for="task in tasks"
          :key="task.id"
          class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-slate-800/60"
          @click="ui.select(task.id)"
        >
          <span
            class="h-2 w-2 shrink-0 rounded-full"
            :style="{ backgroundColor: STATUS_META[task.status].color }"
          />
          <span class="truncate text-xs text-slate-200">{{ task.title }}</span>
          <span class="ml-auto text-[10px] text-slate-500">{{
            STATUS_META[task.status].label
          }}</span>
        </li>
      </ul>
      <div v-else class="text-[11px] text-slate-500">{{ t('inspector.container.noTasks') }}</div>
    </div>
    <p v-if="isFrame" class="text-[11px] text-slate-500">
      {{ t('inspector.container.servicesHint') }}
    </p>
  </div>
</template>
