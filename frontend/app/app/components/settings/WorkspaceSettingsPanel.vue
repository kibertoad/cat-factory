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
import RiskPolicyPanel from '~/components/settings/RiskPolicyPanel.vue'
import IssueTrackerPanel from '~/components/settings/IssueTrackerPanel.vue'
import ServiceFragmentDefaultsPanel from '~/components/settings/ServiceFragmentDefaultsPanel.vue'
import BudgetSettings from '~/components/settings/BudgetSettings.vue'
import UsageSettings from '~/components/settings/UsageSettings.vue'
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'

const { t, te } = useI18n()
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

const tabs = computed(() => [
  {
    value: 'workspace',
    label: t('settings.workspaceSettings.tabs.workspace'),
    icon: 'i-lucide-sliders-horizontal',
    slot: 'workspace',
  },
  {
    value: 'budget',
    label: t('settings.workspaceSettings.tabs.budget'),
    icon: 'i-lucide-wallet',
    slot: 'budget',
  },
  {
    value: 'usage',
    label: t('settings.workspaceSettings.tabs.usage'),
    icon: 'i-lucide-bar-chart-3',
    slot: 'usage',
  },
  {
    value: 'merge',
    label: t('settings.workspaceSettings.tabs.merge'),
    icon: 'i-lucide-git-merge',
    slot: 'merge',
  },
  {
    value: 'tracker',
    label: t('settings.workspaceSettings.tabs.tracker'),
    icon: 'i-lucide-list-checks',
    slot: 'tracker',
  },
  {
    value: 'fragments',
    label: t('settings.workspaceSettings.tabs.fragments'),
    icon: 'i-lucide-book-open-check',
    slot: 'fragments',
  },
])

// Tab strip styling: the labels must always fit (never truncate) and the strip must never
// scroll. So we let the list WRAP onto a second row when the viewport is too narrow
// (`flex-wrap`), keep each trigger at its content width (`shrink-0`, undoing the theme's
// `min-w-0`+`truncate` that otherwise ellipsises labels), and drop the sliding `indicator`
// for a per-trigger bottom border. reka's indicator only tracks `offsetLeft` (not
// `offsetTop`), so it mis-renders once tabs wrap; a border on each active trigger underlines
// the right row regardless. A transparent border on every trigger keeps the rows from
// shifting when the active one gains its colour.
const tabsUi = {
  root: 'gap-4',
  list: 'flex-wrap gap-y-1',
  trigger: 'shrink-0 border-b-2 border-transparent data-[state=active]:border-primary',
  indicator: 'hidden',
}

const TASK_TYPES: CreateTaskType[] = ['feature', 'bug', 'document', 'spike']

// Per-task-type label for the "Max {type} tasks" inputs. An exhaustive Record keyed off
// the CreateTaskType union (a missing member fails the typecheck); each value is a LITERAL
// catalog key so the typed-message-keys check sees it. Leaf keys mirror the enum verbatim.
const TASK_TYPE_KEYS: Record<CreateTaskType, string> = {
  feature: 'settings.workspaceSettings.taskTypes.feature',
  bug: 'settings.workspaceSettings.taskTypes.bug',
  document: 'settings.workspaceSettings.taskTypes.document',
  spike: 'settings.workspaceSettings.taskTypes.spike',
}

const MODES = computed<{ value: TaskLimitMode; label: string }[]>(() => [
  { value: 'off', label: t('settings.workspaceSettings.taskLimit.modes.off') },
  { value: 'shared', label: t('settings.workspaceSettings.taskLimit.modes.shared') },
  { value: 'per_type', label: t('settings.workspaceSettings.taskLimit.modes.per_type') },
])

/** The localized "Max {type} tasks" label for a per-type running-task limit input. */
function maxTaskTypeLabel(type: CreateTaskType): string {
  const key = TASK_TYPE_KEYS[type]
  const typeLabel = te(key) ? t(key) : type
  return t('settings.workspaceSettings.taskLimit.maxPerType', { type: typeLabel })
}

// Local editable copy, kept in sync with the store's settings.
const draft = reactive({
  waitingEscalationMinutes: 120,
  taskLimitMode: 'off' as TaskLimitMode,
  taskLimitShared: 5 as number,
  perType: {} as Record<CreateTaskType, number>,
  storeAgentContext: true,
  artifactRetentionDays: 14,
  kaizenEnabled: true,
})

function hydrate() {
  const s = store.settings
  draft.waitingEscalationMinutes = s.waitingEscalationMinutes
  draft.taskLimitMode = s.taskLimitMode
  draft.taskLimitShared = s.taskLimitShared ?? 5
  const pt = s.taskLimitPerType ?? {}
  for (const t of TASK_TYPES) draft.perType[t] = pt[t] ?? 3
  draft.storeAgentContext = s.storeAgentContext
  draft.artifactRetentionDays = s.artifactRetentionDays
  draft.kaizenEnabled = s.kaizenEnabled
}

// `store.settings` is always replaced wholesale (store hydrate/update reassign the ref),
// so tracking the object reference is enough — no deep per-field traversal needed.
watch(() => store.settings, hydrate, { immediate: true })

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
      artifactRetentionDays: draft.artifactRetentionDays,
      kaizenEnabled: draft.kaizenEnabled,
    })
    toast.add({
      title: t('settings.workspaceSettings.toast.saved'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    toast.add({
      title: t('settings.workspaceSettings.toast.saveFailed'),
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
  <UModal
    v-model:open="open"
    :title="t('settings.workspaceSettings.title')"
    :ui="{ content: 'max-w-3xl' }"
  >
    <template #title>
      <IntegrationBackTitle :title="t('settings.workspaceSettings.title')" @back="back" />
    </template>
    <template #body>
      <UTabs v-model="activeTab" :items="tabs" variant="link" :ui="tabsUi">
        <!-- Workspace -->
        <template #workspace>
          <div class="space-y-6">
            <!-- Run-timing escalation -->
            <section class="space-y-2">
              <h3 class="text-sm font-semibold text-slate-200">
                {{ t('settings.workspaceSettings.waiting.heading') }}
              </h3>
              <p class="text-[11px] text-slate-400">
                <i18n-t keypath="settings.workspaceSettings.waiting.body" tag="span" scope="global">
                  <template #overdue>
                    <span class="text-error-400">{{
                      t('settings.workspaceSettings.waiting.overdue')
                    }}</span>
                  </template>
                </i18n-t>
              </p>
              <label class="block w-48">
                <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
                  {{ t('settings.workspaceSettings.waiting.escalateAfter') }}
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
              <h3 class="text-sm font-semibold text-slate-200">
                {{ t('settings.workspaceSettings.taskLimit.heading') }}
              </h3>
              <p class="text-[11px] text-slate-400">
                {{ t('settings.workspaceSettings.taskLimit.body') }}
              </p>
              <label class="block w-64">
                <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">{{
                  t('settings.workspaceSettings.taskLimit.mode')
                }}</span>
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
                  {{ t('settings.workspaceSettings.taskLimit.maxRunning') }}
                </span>
                <UInput v-model.number="draft.taskLimitShared" type="number" :min="1" size="sm" />
              </label>

              <div
                v-else-if="draft.taskLimitMode === 'per_type'"
                class="grid grid-cols-1 gap-3 sm:grid-cols-2"
              >
                <label v-for="taskType in TASK_TYPES" :key="taskType" class="block">
                  <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
                    {{ maxTaskTypeLabel(taskType) }}
                  </span>
                  <UInput
                    v-model.number="draft.perType[taskType]"
                    type="number"
                    :min="1"
                    size="sm"
                  />
                </label>
              </div>
            </section>

            <!-- Agent observability -->
            <section class="space-y-2">
              <h3 class="text-sm font-semibold text-slate-200">
                {{ t('settings.workspaceSettings.observability.heading') }}
              </h3>
              <p class="text-[11px] text-slate-400">
                {{ t('settings.workspaceSettings.observability.body') }}
              </p>
              <label class="flex items-center gap-2">
                <USwitch v-model="draft.storeAgentContext" size="sm" />
                <span class="text-sm text-slate-200">{{
                  t('settings.workspaceSettings.observability.toggle')
                }}</span>
              </label>
            </section>

            <!-- Visual-confirmation artifact retention -->
            <section class="space-y-2">
              <h3 class="text-sm font-semibold text-slate-200">
                {{ t('settings.workspaceSettings.retention.heading') }}
              </h3>
              <p class="text-[11px] text-slate-400">
                {{ t('settings.workspaceSettings.retention.body') }}
              </p>
              <label class="block w-48">
                <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
                  {{ t('settings.workspaceSettings.retention.days') }}
                </span>
                <UInput
                  v-model.number="draft.artifactRetentionDays"
                  type="number"
                  :min="1"
                  :max="3650"
                  size="sm"
                />
              </label>
            </section>

            <!-- Kaizen agent -->
            <section class="space-y-2">
              <h3 class="text-sm font-semibold text-slate-200">
                {{ t('settings.workspaceSettings.kaizen.heading') }}
              </h3>
              <p class="text-[11px] text-slate-400">
                {{ t('settings.workspaceSettings.kaizen.body') }}
              </p>
              <label class="flex items-center gap-2">
                <USwitch v-model="draft.kaizenEnabled" size="sm" />
                <span class="text-sm text-slate-200">{{
                  t('settings.workspaceSettings.kaizen.toggle')
                }}</span>
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
                {{ t('common.save') }}
              </UButton>
            </div>
          </div>
        </template>

        <!-- Budget (workspace / account / user tiers) -->
        <template #budget>
          <BudgetSettings />
        </template>

        <!-- Usage report (metered + subscription token usage this period) -->
        <template #usage>
          <UsageSettings />
        </template>

        <!-- Merge thresholds -->
        <template #merge>
          <RiskPolicyPanel />
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
