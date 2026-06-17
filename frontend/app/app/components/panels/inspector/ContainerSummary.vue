<script setup lang="ts">
import type { Block } from '~/types/domain'
import { STATUS_META } from '~/utils/catalog'

const props = defineProps<{ block: Block }>()

const board = useBoardStore()
const ui = useUiStore()

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
        Modules ({{ modules.length }})
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
          <span class="ml-auto text-[10px] text-slate-500"
            >{{ board.tasksOf(m.id).length }} task(s)</span
          >
        </li>
      </ul>
    </div>

    <div>
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {{ isFrame ? 'All tasks' : 'Tasks' }} ({{ tasks.length }})
        </span>
        <UButton size="xs" variant="soft" color="primary" icon="i-lucide-plus" @click="addTask">
          Add task
        </UButton>
      </div>
      <ul v-if="tasks.length" class="space-y-1">
        <li
          v-for="t in tasks"
          :key="t.id"
          class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-slate-800/60"
          @click="ui.select(t.id)"
        >
          <span
            class="h-2 w-2 shrink-0 rounded-full"
            :style="{ backgroundColor: STATUS_META[t.status].color }"
          />
          <span class="truncate text-xs text-slate-200">{{ t.title }}</span>
          <span class="ml-auto text-[10px] text-slate-500">{{ STATUS_META[t.status].label }}</span>
        </li>
      </ul>
      <div v-else class="text-[11px] text-slate-500">No tasks yet — add one to start work.</div>
    </div>
    <p v-if="isFrame" class="text-[11px] text-slate-500">
      Services are long-lived — they don't "complete". Work happens in their tasks &amp; modules.
    </p>
  </div>
</template>
