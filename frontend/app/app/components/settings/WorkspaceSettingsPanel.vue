<script setup lang="ts">
// Workspace settings: the run-timing escalation threshold and the per-service
// running-task limit policy.
//   - waitingEscalationMinutes — runs never time out waiting for a human; after this
//     long their notification escalates yellow → red ("Overdue") in the inbox.
//   - task limit — cap how many tasks may run concurrently under one service, either
//     as a single shared bucket across all types or one bucket per task type.
import { reactive, ref, watch } from 'vue'
import type { CreateTaskType, TaskLimitMode } from '~/types/domain'

const ui = useUiStore()
const store = useWorkspaceSettingsStore()
const toast = useToast()

const open = computed({
  get: () => ui.workspaceSettingsOpen,
  set: (v: boolean) => (v ? ui.openWorkspaceSettings() : ui.closeWorkspaceSettings()),
})

const TASK_TYPES: CreateTaskType[] = ['feature', 'bug', 'document', 'spike']
const MODES: { value: TaskLimitMode; label: string }[] = [
  { value: 'off', label: 'No limit' },
  { value: 'shared', label: 'Shared across all types' },
  { value: 'per_type', label: 'Per task type' },
]

// Local editable copy, kept in sync with the store's settings.
const draft = reactive({
  waitingEscalationMinutes: 120,
  taskLimitMode: 'off' as TaskLimitMode,
  taskLimitShared: 5 as number,
  perType: {} as Record<CreateTaskType, number>,
})

function hydrate() {
  const s = store.settings
  draft.waitingEscalationMinutes = s.waitingEscalationMinutes
  draft.taskLimitMode = s.taskLimitMode
  draft.taskLimitShared = s.taskLimitShared ?? 5
  const pt = s.taskLimitPerType ?? {}
  for (const t of TASK_TYPES) draft.perType[t] = pt[t] ?? 3
}

watch(() => store.settings, hydrate, { immediate: true, deep: true })

const saving = ref(false)

async function save() {
  saving.value = true
  try {
    await store.update({
      waitingEscalationMinutes: draft.waitingEscalationMinutes,
      taskLimitMode: draft.taskLimitMode,
      taskLimitShared: draft.taskLimitMode === 'shared' ? draft.taskLimitShared : null,
      taskLimitPerType:
        draft.taskLimitMode === 'per_type'
          ? TASK_TYPES.reduce(
              (acc, t) => {
                acc[t] = draft.perType[t]
                return acc
              },
              {} as Record<CreateTaskType, number>,
            )
          : null,
    })
    toast.add({ title: 'Settings saved', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    toast.add({
      title: 'Could not save settings',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Workspace settings" :ui="{ content: 'max-w-xl' }">
    <template #body>
      <div class="space-y-6">
        <!-- Run-timing escalation -->
        <section class="space-y-2">
          <h3 class="text-sm font-semibold text-slate-200">Waiting for a human</h3>
          <p class="text-[11px] text-slate-400">
            A run parked on a human decision (a review, an approval, a merge) waits as long as
            it needs — it is never cancelled. After this many minutes its notification turns red
            and is flagged <span class="text-error-400">Overdue</span> in the inbox.
          </p>
          <label class="block w-48">
            <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
              Escalate after (minutes)
            </span>
            <UInput
              v-model.number="draft.waitingEscalationMinutes"
              type="number"
              :min="1"
              size="sm"
            />
          </label>
        </section>

        <!-- Per-service running-task limit -->
        <section class="space-y-2">
          <h3 class="text-sm font-semibold text-slate-200">Running tasks per service</h3>
          <p class="text-[11px] text-slate-400">
            Cap how many tasks may run at once under one service. Starting a task over the limit
            is refused with a clear message until a running task finishes.
          </p>
          <label class="block w-64">
            <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">Mode</span>
            <USelect v-model="draft.taskLimitMode" :items="MODES" value-key="value" size="sm" />
          </label>

          <label v-if="draft.taskLimitMode === 'shared'" class="block w-48">
            <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
              Max running tasks
            </span>
            <UInput v-model.number="draft.taskLimitShared" type="number" :min="1" size="sm" />
          </label>

          <div v-else-if="draft.taskLimitMode === 'per_type'" class="grid grid-cols-2 gap-3">
            <label v-for="t in TASK_TYPES" :key="t" class="block">
              <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
                Max {{ t }} tasks
              </span>
              <UInput v-model.number="draft.perType[t]" type="number" :min="1" size="sm" />
            </label>
          </div>
        </section>

        <div class="flex justify-end">
          <UButton
            color="primary"
            icon="i-lucide-save"
            size="sm"
            :loading="saving"
            @click="save"
          >
            Save
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
