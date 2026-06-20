<script setup lang="ts">
// Inspector section shown when the selected task block backs a recurring pipeline.
// Lets the user edit the cadence, pause/resume, run now, and review the run history
// (lazily loaded; retained ~1 week on the backend).
import type { Block } from '~/types/domain'
import type { Recurrence } from '~/types/recurring'

const props = defineProps<{ block: Block }>()
const recurring = useRecurringPipelinesStore()
const pipelines = usePipelinesStore()
const toast = useToast()

const schedule = computed(() => recurring.byBlock(props.block.id))
const runs = computed(() =>
  schedule.value ? (recurring.runsBySchedule[schedule.value.id] ?? []) : [],
)

const editing = ref(false)
const draft = ref<Recurrence | null>(null)
const busy = ref(false)

// Load history whenever a schedule is shown.
watch(
  () => schedule.value?.id,
  (id) => {
    if (id) recurring.loadRuns(id).catch(() => {})
  },
  { immediate: true },
)

const pipelineName = computed(
  () => pipelines.getPipeline(schedule.value?.pipelineId ?? '')?.name ?? schedule.value?.pipelineId,
)

function describeCadence(r: Recurrence): string {
  const every = r.intervalHours % 24 === 0 ? `${r.intervalHours / 24}d` : `${r.intervalHours}h`
  const days =
    r.weekdays.length === 0
      ? 'any day'
      : r.weekdays.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(' ')
  const window =
    r.windowStartHour === null && r.windowEndHour === null
      ? ''
      : ` · ${String(r.windowStartHour ?? 0).padStart(2, '0')}:00–${String(r.windowEndHour ?? 24).padStart(2, '0')}:00`
  return `Every ${every} · ${days}${window} · ${r.timezone}`
}

function startEdit() {
  if (!schedule.value) return
  draft.value = { ...schedule.value.recurrence }
  editing.value = true
}

async function saveEdit() {
  if (!schedule.value || !draft.value) return
  busy.value = true
  try {
    await recurring.update(schedule.value.id, { recurrence: draft.value })
    editing.value = false
  } catch (e) {
    toast.add({ title: 'Could not update schedule', description: errMsg(e), color: 'error' })
  } finally {
    busy.value = false
  }
}

async function toggleEnabled() {
  if (!schedule.value) return
  busy.value = true
  try {
    await recurring.update(schedule.value.id, { enabled: !schedule.value.enabled })
  } catch (e) {
    toast.add({ title: 'Could not update schedule', description: errMsg(e), color: 'error' })
  } finally {
    busy.value = false
  }
}

async function runNow() {
  if (!schedule.value) return
  busy.value = true
  try {
    await recurring.runNow(schedule.value.id)
  } catch (e) {
    toast.add({ title: 'Could not run now', description: errMsg(e), color: 'error' })
  } finally {
    busy.value = false
  }
}

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : String(e)
}

const RUN_COLOR: Record<string, string> = {
  running: 'text-amber-400',
  done: 'text-emerald-400',
  failed: 'text-rose-400',
  skipped: 'text-slate-500',
}
function fmtTime(ms: number) {
  return new Date(ms).toLocaleString()
}
</script>

<template>
  <div v-if="schedule" class="space-y-2 rounded-lg border border-indigo-900/50 bg-indigo-950/20 p-3">
    <div class="flex items-center justify-between">
      <span class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-indigo-300">
        <UIcon name="i-lucide-repeat" class="h-3.5 w-3.5" />
        Recurring pipeline
      </span>
      <UBadge :color="schedule.enabled ? 'primary' : 'neutral'" variant="subtle" size="xs">
        {{ schedule.enabled ? 'Active' : 'Paused' }}
      </UBadge>
    </div>

    <p class="text-[11px] text-slate-400">
      <span class="text-slate-300">{{ pipelineName }}</span>
    </p>

    <template v-if="!editing">
      <p class="text-[11px] text-slate-400">{{ describeCadence(schedule.recurrence) }}</p>
      <p class="text-[11px] text-slate-500">
        Next run: {{ fmtTime(schedule.nextRunAt) }}
      </p>
      <div class="flex flex-wrap gap-1.5 pt-1">
        <UButton size="xs" variant="soft" icon="i-lucide-play" :loading="busy" @click="runNow">
          Run now
        </UButton>
        <UButton
          size="xs"
          variant="soft"
          color="neutral"
          :icon="schedule.enabled ? 'i-lucide-pause' : 'i-lucide-play'"
          :loading="busy"
          @click="toggleEnabled"
        >
          {{ schedule.enabled ? 'Pause' : 'Resume' }}
        </UButton>
        <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-pencil" @click="startEdit">
          Edit cadence
        </UButton>
      </div>
    </template>

    <template v-else-if="draft">
      <RecurringRecurrenceEditor v-model="draft" />
      <div class="flex justify-end gap-1.5 pt-1">
        <UButton size="xs" variant="ghost" color="neutral" @click="editing = false">Cancel</UButton>
        <UButton size="xs" color="primary" :loading="busy" @click="saveEdit">Save</UButton>
      </div>
    </template>

    <!-- run history -->
    <div v-if="runs.length" class="space-y-1 border-t border-slate-800 pt-2">
      <span class="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        Recent runs
      </span>
      <div
        v-for="run in runs"
        :key="run.id"
        class="flex items-center gap-2 text-[11px]"
      >
        <span :class="RUN_COLOR[run.status] ?? 'text-slate-400'" class="w-14 shrink-0 capitalize">
          {{ run.status }}
        </span>
        <span class="truncate text-slate-500">{{ fmtTime(run.startedAt) }}</span>
        <span v-if="run.outcome" class="ml-auto truncate text-slate-500">{{ run.outcome }}</span>
      </div>
    </div>
  </div>
</template>
