<script setup lang="ts">
// Import an issue from a connected task source (by key or URL) and review the
// issues already imported into the workspace. Unlike the document import flow
// there is no plan/spawn — issues are attached to a task block for context from
// the inspector (see TaskContextIssues.vue).
import type { TaskSourceKind } from '~/types/domain'

const ui = useUiStore()
const tasks = useTasksStore()
const toast = useToast()

const open = computed({
  get: () => ui.taskImport !== null,
  set: (v: boolean) => {
    if (!v) ui.closeTaskImport()
  },
})

const source = ref<TaskSourceKind | undefined>(undefined)
const ref_ = ref('')
const importing = ref(false)

const sourceItems = computed(() =>
  tasks.connectedSources.map((s) => ({ label: s.label, value: s.source })),
)
const descriptor = computed(() => (source.value ? tasks.descriptorFor(source.value) : undefined))

const sourceTasks = computed(() =>
  source.value ? tasks.tasks.filter((t) => t.source === source.value) : [],
)

watch(open, (isOpen) => {
  if (isOpen) {
    ref_.value = ''
    source.value = ui.taskImport?.source ?? tasks.connectedSources[0]?.source ?? undefined
    tasks.loadTasks().catch(() => {})
  }
})

async function doImport() {
  const value = ref_.value.trim()
  if (!value || !source.value) return
  importing.value = true
  try {
    const task = await tasks.importTask(source.value, value)
    ref_.value = ''
    toast.add({ title: `Imported "${task.title}"`, icon: 'i-lucide-file-down' })
  } catch (e) {
    toast.add({
      title: 'Import failed',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Import from a task source">
    <template #body>
      <!-- Empty state: no connections -->
      <div v-if="!tasks.anyConnected" class="space-y-3 text-center">
        <UIcon name="i-lucide-plug" class="mx-auto h-8 w-8 text-slate-500" />
        <p class="text-sm text-slate-400">Connect a task source first.</p>
        <div class="flex justify-center gap-2">
          <UButton
            v-for="s in tasks.sources"
            :key="s.source"
            color="primary"
            variant="soft"
            :icon="s.icon"
            @click="ui.openTaskConnect(s.source)"
          >
            Connect {{ s.label }}
          </UButton>
        </div>
      </div>

      <!-- Main form -->
      <div v-else class="space-y-4">
        <UFormField v-if="sourceItems.length > 1" label="Source">
          <USelect v-model="source" :items="sourceItems" class="w-full" />
        </UFormField>

        <div class="flex items-end gap-2">
          <UFormField :label="descriptor?.refLabel ?? 'Issue key or URL'" class="flex-1">
            <UInput
              v-model="ref_"
              :placeholder="descriptor?.refPlaceholder"
              class="w-full"
              @keydown.enter="doImport"
            />
          </UFormField>
          <UButton
            color="primary"
            icon="i-lucide-file-down"
            :loading="importing"
            :disabled="!ref_.trim()"
            @click="doImport"
          >
            Import
          </UButton>
        </div>

        <!-- List of already-imported issues -->
        <div v-if="sourceTasks.length" class="space-y-2">
          <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Imported issues
          </h3>
          <div
            v-for="task in sourceTasks"
            :key="`${task.source}:${task.externalId}`"
            class="rounded-lg border border-slate-800 bg-slate-900/60 p-3"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <a
                  :href="task.url"
                  target="_blank"
                  rel="noopener"
                  class="truncate text-sm font-medium text-white hover:underline"
                >
                  {{ task.externalId }} · {{ task.title }}
                </a>
                <p class="mt-0.5 line-clamp-2 text-xs text-slate-500">{{ task.excerpt }}</p>
              </div>
              <UBadge color="neutral" variant="soft" size="xs" class="shrink-0">
                {{ task.status }}
              </UBadge>
            </div>
          </div>
        </div>
        <p v-else class="text-center text-xs text-slate-500">No issues imported yet.</p>
      </div>
    </template>
  </UModal>
</template>
