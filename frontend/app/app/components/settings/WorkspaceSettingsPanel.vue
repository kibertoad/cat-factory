<script setup lang="ts">
// Workspace settings — a single tabbed modal that gathers the workspace-wide
// configuration that used to live in separate windows:
//   - Workspace: the run-timing escalation threshold + per-service running-task limit.
//   - Merge thresholds: the auto-merge preset library.
//   - Issue tracker: filing-tracker selection + linking sources + writeback.
//   - Service best practices: the default fragments new services inherit.
// The latter three are body-only section components rendered in tabs here (no longer
// standalone modals).
import { reactive, ref, watch } from 'vue'
import type { CreateTaskType, TaskLimitMode } from '~/types/domain'
import MergeThresholdsPanel from '~/components/settings/MergeThresholdsPanel.vue'
import IssueTrackerPanel from '~/components/settings/IssueTrackerPanel.vue'
import ServiceFragmentDefaultsPanel from '~/components/settings/ServiceFragmentDefaultsPanel.vue'
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'

const ui = useUiStore()
const store = useWorkspaceSettingsStore()
const toast = useToast()

const open = computed({
  get: () => ui.workspaceSettingsOpen,
  set: (v: boolean) => (v ? ui.openWorkspaceSettings() : ui.closeWorkspaceSettings()),
})
const back = useIntegrationBack(open)

// Which tab is shown — driven by the ui store so other surfaces (command bar,
// integrations) can deep-link straight to a tab.
const activeTab = computed({
  get: () => ui.workspaceSettingsTab,
  set: (v: string) => ui.setWorkspaceSettingsTab(v),
})

const tabs = [
  {
    value: 'workspace',
    label: 'Workspace',
    icon: 'i-lucide-sliders-horizontal',
    slot: 'workspace',
  },
  { value: 'budget', label: 'Budget', icon: 'i-lucide-wallet', slot: 'budget' },
  { value: 'merge', label: 'Merge thresholds', icon: 'i-lucide-git-merge', slot: 'merge' },
  {
    value: 'tracker',
    label: 'Issue tracker',
    icon: 'i-lucide-list-checks',
    slot: 'tracker',
  },
  {
    value: 'fragments',
    label: 'Service best practices',
    icon: 'i-lucide-book-open-check',
    slot: 'fragments',
  },
]

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
  storeAgentContext: true,
  kaizenEnabled: true,
  // Budget: empty string ⇒ "use the built-in default" (null on the wire).
  spendCurrency: '',
  spendMonthlyLimit: '',
})

function hydrate() {
  const s = store.settings
  draft.waitingEscalationMinutes = s.waitingEscalationMinutes
  draft.taskLimitMode = s.taskLimitMode
  draft.taskLimitShared = s.taskLimitShared ?? 5
  const pt = s.taskLimitPerType ?? {}
  for (const t of TASK_TYPES) draft.perType[t] = pt[t] ?? 3
  draft.storeAgentContext = s.storeAgentContext
  draft.kaizenEnabled = s.kaizenEnabled
  draft.spendCurrency = s.spendCurrency ?? ''
  draft.spendMonthlyLimit = s.spendMonthlyLimit == null ? '' : String(s.spendMonthlyLimit)
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
      storeAgentContext: draft.storeAgentContext,
      kaizenEnabled: draft.kaizenEnabled,
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

const savingBudget = ref(false)

async function saveBudget() {
  savingBudget.value = true
  // The number input emits a raw number once edited but starts as a string from hydrate, so
  // coerce through String() before trimming. Blank ⇒ "use the built-in default" (null on the wire).
  const raw = String(draft.spendMonthlyLimit ?? '').trim()
  const monthlyLimit = raw === '' ? null : Number(raw)
  try {
    await store.update({
      spendCurrency: draft.spendCurrency.trim() ? draft.spendCurrency.trim().toUpperCase() : null,
      spendMonthlyLimit: monthlyLimit,
    })
    toast.add({ title: 'Budget saved', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    toast.add({
      title: 'Could not save budget',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    savingBudget.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Workspace settings" :ui="{ content: 'max-w-3xl' }">
    <template #title>
      <IntegrationBackTitle title="Workspace settings" @back="back" />
    </template>
    <template #body>
      <UTabs
        v-model="activeTab"
        :items="tabs"
        variant="link"
        :ui="{ root: 'gap-4', list: 'overflow-x-auto' }"
      >
        <!-- Workspace -->
        <template #workspace>
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
                <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500"
                  >Mode</span
                >
                <USelect
                  v-model="draft.taskLimitMode"
                  :items="MODES"
                  value-key="value"
                  size="sm"
                  class="w-full"
                />
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

            <!-- Agent observability -->
            <section class="space-y-2">
              <h3 class="text-sm font-semibold text-slate-200">Agent observability</h3>
              <p class="text-[11px] text-slate-400">
                Store the complete context provided to each agent — the composed prompts, the
                best-practice fragments folded in, and the full content of the files injected into
                its container — so it can be inspected later in the observability view. The bodies
                are kept for the same window as the per-call LLM telemetry. Turn off to stop storing
                it (existing snapshots are pruned by retention).
              </p>
              <label class="flex items-center gap-2">
                <USwitch v-model="draft.storeAgentContext" size="sm" />
                <span class="text-sm text-slate-200">Store full agent context</span>
              </label>
            </section>

            <!-- Kaizen agent -->
            <section class="space-y-2">
              <h3 class="text-sm font-semibold text-slate-200">Kaizen agent</h3>
              <p class="text-[11px] text-slate-400">
                After each run completes, the Kaizen agent grades how every agent step went — smooth
                and efficient vs confused and chaotic — and recommends prompt/model improvements. A
                prompt + agent + model combination that grades highly with no recommendations five
                times in a row is marked verified and is no longer graded. Grading runs in the
                background and is shown inside run details and the Kaizen screen. Set the grader's
                model in Model Configuration (the “Kaizen” agent).
              </p>
              <label class="flex items-center gap-2">
                <USwitch v-model="draft.kaizenEnabled" size="sm" />
                <span class="text-sm text-slate-200">Grade agent runs with Kaizen</span>
              </label>
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

        <!-- Budget -->
        <template #budget>
          <div class="space-y-6">
            <section class="space-y-2">
              <h3 class="text-sm font-semibold text-slate-200">Monthly spend budget</h3>
              <p class="text-[11px] text-slate-400">
                Token usage is metered per LLM call, priced, and gated by this budget — when
                reached, runs in this workspace pause and the board shows a warning. Leave blank to
                inherit the built-in default (~100&nbsp;EUR/month).
              </p>
              <div class="grid grid-cols-2 gap-3">
                <label class="block">
                  <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
                    Monthly limit
                  </span>
                  <UInput
                    v-model="draft.spendMonthlyLimit"
                    type="number"
                    :min="0"
                    placeholder="Default"
                    size="sm"
                  />
                </label>
                <label class="block">
                  <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
                    Currency (ISO 4217)
                  </span>
                  <UInput
                    v-model="draft.spendCurrency"
                    placeholder="EUR"
                    maxlength="3"
                    size="sm"
                    class="uppercase"
                  />
                </label>
              </div>
            </section>

            <div class="flex justify-end">
              <UButton
                color="primary"
                icon="i-lucide-save"
                size="sm"
                :loading="savingBudget"
                @click="saveBudget"
              >
                Save budget
              </UButton>
            </div>
          </div>
        </template>

        <!-- Merge thresholds -->
        <template #merge>
          <MergeThresholdsPanel />
        </template>

        <!-- Issue tracker -->
        <template #tracker>
          <IssueTrackerPanel />
        </template>

        <!-- Service best practices -->
        <template #fragments>
          <ServiceFragmentDefaultsPanel />
        </template>
      </UTabs>
    </template>
  </UModal>
</template>
