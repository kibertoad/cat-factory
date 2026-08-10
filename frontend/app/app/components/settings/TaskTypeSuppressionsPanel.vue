<script setup lang="ts">
// Workspace settings: which of the deployment's REUSABLE OPERATIONS this board offers
// (`backend/docs/reusable-operations.md`). An org registers its operations process-wide, so a
// team that runs three of twenty needs a way to clear the rest out of its create picker.
//
// The list comes from its OWN read, not from the board snapshot's `customTaskTypes`: a suppressed
// operation is by construction absent from that catalog, so this screen is the only surface that
// can offer the way back. Every write answers with the whole list AND invalidates the catalog the
// picker renders, so a change is followed by a board refresh rather than a local patch.
//
// Labels and descriptions are DEPLOYMENT-authored English rendered verbatim (the descriptor
// convention); only the chrome around them is i18n.
import { onMounted, ref } from 'vue'
import type { TaskTypeSuppression } from '~/types/domain'

const { t } = useI18n()
const api = useApi()
const workspace = useWorkspaceStore()
const { present } = usePipelineErrorToast()

const rows = ref<TaskTypeSuppression[]>([])
const loading = ref(false)
/** The single id being written, so only its own switch shows the pending state. */
const busyId = ref<string | null>(null)

onMounted(() => void load())

async function load() {
  if (!workspace.workspaceId) return
  loading.value = true
  try {
    rows.value = (await api.listTaskTypeSuppressions(workspace.requireId())).taskTypes
  } catch (e) {
    present(e, 'settings.taskTypeSuppressions.saveFailed')
  } finally {
    loading.value = false
  }
}

/**
 * Flip one operation. The board snapshot's task-type catalog is derived from this state, so a
 * successful write refreshes the workspace: leaving it stale would keep offering a hidden
 * operation in the create picker until the next unrelated reload.
 */
async function toggle(row: TaskTypeSuppression, offered: boolean) {
  const id = row.taskType.taskType
  busyId.value = id
  try {
    const result = offered
      ? await api.restoreTaskType(workspace.requireId(), id)
      : await api.suppressTaskType(workspace.requireId(), id)
    rows.value = result.taskTypes
    await workspace.refresh()
  } catch (e) {
    present(e, 'settings.taskTypeSuppressions.saveFailed')
  } finally {
    busyId.value = null
  }
}
</script>

<template>
  <div class="space-y-4">
    <p class="text-xs text-slate-400">
      {{ t('settings.taskTypeSuppressions.intro') }}
    </p>

    <p v-if="loading" class="text-[11px] text-slate-500">
      {{ t('settings.taskTypeSuppressions.loading') }}
    </p>
    <p v-else-if="!rows.length" class="text-[11px] text-slate-500">
      {{ t('settings.taskTypeSuppressions.empty') }}
    </p>
    <ul v-else class="space-y-2" data-testid="task-type-suppressions">
      <li
        v-for="row in rows"
        :key="row.taskType.taskType"
        class="flex items-start justify-between gap-3 rounded border border-slate-800 px-3 py-2"
        data-testid="task-type-suppression"
        :data-task-type="row.taskType.taskType"
      >
        <div class="min-w-0">
          <div class="flex items-center gap-1.5">
            <UIcon :name="row.taskType.presentation.icon" class="h-3.5 w-3.5 shrink-0" />
            <span class="truncate text-xs font-medium text-slate-200">
              {{ row.taskType.presentation.label }}
            </span>
            <UBadge
              v-if="row.taskType.presentation.category"
              color="neutral"
              variant="subtle"
              size="sm"
            >
              {{ row.taskType.presentation.category }}
            </UBadge>
          </div>
          <p class="mt-0.5 text-[11px] text-slate-500">
            {{ row.taskType.presentation.description }}
          </p>
        </div>
        <USwitch
          :model-value="!row.suppressed"
          :loading="busyId === row.taskType.taskType"
          :aria-label="t('settings.taskTypeSuppressions.offer')"
          @update:model-value="(offered: boolean) => toggle(row, offered)"
        />
      </li>
    </ul>
  </div>
</template>
