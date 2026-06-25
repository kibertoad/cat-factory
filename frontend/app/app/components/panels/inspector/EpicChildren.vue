<script setup lang="ts">
import { computed } from 'vue'
import type { Block } from '~/types/domain'
import { STATUS_META } from '~/utils/catalog'

// The epic inspector body: the full tree of member tasks (which may live under different
// services/modules), grouped service → module → task. Each task row selects it. Membership
// is the task's `epicId`; the epic is non-structural, so this reads across the whole board.
const props = defineProps<{ block: Block }>()

const board = useBoardStore()
const ui = useUiStore()

const members = computed(() => board.epicMembers(props.block.id))
const done = computed(() => members.value.filter((m) => m.status === 'done').length)

/** Member tasks grouped by their owning service, then by module (or "direct"). */
const groups = computed(() => {
  const byService = new Map<
    string,
    {
      service: Block | undefined
      modules: Map<string, { module: Block | undefined; tasks: Block[] }>
    }
  >()
  for (const task of members.value) {
    const service = board.serviceOf(task)
    const serviceKey = service?.id ?? '—'
    if (!byService.has(serviceKey)) byService.set(serviceKey, { service, modules: new Map() })
    const group = byService.get(serviceKey)!
    // The task's structural container: a module when its parent is a module, else "direct".
    const parent = task.parentId ? board.getBlock(task.parentId) : undefined
    const moduleKey = parent && parent.level === 'module' ? parent.id : '—'
    if (!group.modules.has(moduleKey)) {
      group.modules.set(moduleKey, {
        module: parent?.level === 'module' ? parent : undefined,
        tasks: [],
      })
    }
    group.modules.get(moduleKey)!.tasks.push(task)
  }
  return [...byService.values()]
})
</script>

<template>
  <div>
    <div class="mb-1 flex items-center justify-between">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        Epic tasks
      </span>
      <span class="text-[11px] text-slate-500">{{ done }}/{{ members.length }} done</span>
    </div>

    <div v-if="members.length === 0" class="text-[11px] text-slate-500">
      No tasks belong to this epic yet. Import an epic's children, or set a task's epic.
    </div>

    <div v-else class="space-y-2">
      <div
        v-for="(group, gi) in groups"
        :key="gi"
        class="rounded-md border border-slate-700/60 p-2"
      >
        <div class="mb-1 flex items-center gap-1 text-[11px] font-medium text-slate-300">
          <UIcon name="i-lucide-box" class="h-3 w-3 text-slate-500" />
          {{ group.service?.title ?? 'Unassigned' }}
        </div>
        <div v-for="(mod, mi) in [...group.modules.values()]" :key="mi" class="pl-1">
          <div v-if="mod.module" class="text-[10px] uppercase tracking-wide text-slate-500">
            {{ mod.module.title }}
          </div>
          <button
            v-for="task in mod.tasks"
            :key="task.id"
            type="button"
            class="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs text-slate-200 hover:bg-slate-800"
            @click="ui.select(task.id)"
          >
            <span
              class="h-2 w-2 shrink-0 rounded-full"
              :style="{ backgroundColor: STATUS_META[task.status].color }"
            />
            <span class="truncate">{{ task.title }}</span>
            <span class="ml-auto shrink-0 text-[10px] text-slate-500">
              {{ STATUS_META[task.status].label }}
            </span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
