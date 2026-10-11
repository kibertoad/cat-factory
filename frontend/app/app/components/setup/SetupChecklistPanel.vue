<script setup lang="ts">
import type { SetupRowId, SetupRowStatus } from '~/utils/setupChecklist'
import SectionLabel from '~/components/common/SectionLabel.vue'

/**
 * The setup checklist: every prerequisite for "a task can run and merge", its state, and one
 * action per row (issue #2258).
 *
 * The probes and the surfaces each row opens are the ones the setup banners, the AI-provider
 * dialogs and the startup health advisories already use (`useSetupChecklist`). What it adds is
 * the whole list in one place, with a finish line, instead of one interruption per missing piece.
 * Opening a row's surface closes the checklist, so the two never stack.
 */
const { t } = useI18n()
const ui = useUiStore()
const { checklist, act: openRow, canAct } = useSetupChecklist()

const open = computed({
  get: () => ui.setupChecklistOpen,
  set: (v: boolean) => (v ? ui.openSetupChecklist() : ui.closeSetupChecklist()),
})

/** Open a surface from the checklist: close the checklist first, so the two never stack. */
function go(fn: () => void) {
  ui.closeSetupChecklist()
  fn()
}
function act(id: SetupRowId) {
  go(() => openRow(id))
}
const pipelineHealth = usePipelineHealth()
const riskPolicyHealth = useRiskPolicyHealth()
const modelPresetHealth = useModelPresetHealth()

const STATUS_META: Record<SetupRowStatus, { icon: string; class: string; actionKey: string }> = {
  done: { icon: 'i-lucide-circle-check', class: 'text-success', actionKey: 'setup.action.change' },
  missing: { icon: 'i-lucide-circle', class: 'text-dimmed', actionKey: 'setup.action.connect' },
  attention: {
    icon: 'i-lucide-circle-alert',
    class: 'text-warning',
    actionKey: 'setup.action.fix',
  },
  checking: {
    icon: 'i-lucide-loader-circle',
    class: 'animate-spin text-dimmed',
    actionKey: 'setup.action.connect',
  },
  not_needed: {
    icon: 'i-lucide-circle-minus',
    class: 'text-dimmed',
    actionKey: 'setup.action.change',
  },
}

/** Each row's title and one line per status. Exhaustive, so a new row or status must say what it means. */
const ROW_COPY: Record<SetupRowId, { title: string } & Record<SetupRowStatus, string>> = {
  model: {
    title: 'setup.rows.model.title',
    done: 'setup.rows.model.done',
    missing: 'setup.rows.model.missing',
    attention: 'setup.rows.model.attention',
    checking: 'setup.rows.checking',
    not_needed: 'setup.rows.notNeeded',
  },
  sourceControl: {
    title: 'setup.rows.sourceControl.title',
    done: 'setup.rows.sourceControl.done',
    missing: 'setup.rows.sourceControl.missing',
    attention: 'setup.rows.sourceControl.attention',
    checking: 'setup.rows.checking',
    not_needed: 'setup.rows.notNeeded',
  },
  agentExecutor: {
    title: 'setup.rows.agentExecutor.title',
    done: 'setup.rows.agentExecutor.done',
    missing: 'setup.rows.agentExecutor.missing',
    attention: 'setup.rows.agentExecutor.attention',
    checking: 'setup.rows.checking',
    not_needed: 'setup.rows.agentExecutor.notNeeded',
  },
  testEnvironments: {
    title: 'setup.rows.testEnvironments.title',
    done: 'setup.rows.testEnvironments.done',
    missing: 'setup.rows.testEnvironments.missing',
    attention: 'setup.rows.testEnvironments.attention',
    checking: 'setup.rows.checking',
    not_needed: 'setup.rows.notNeeded',
  },
  contentStorage: {
    title: 'setup.rows.contentStorage.title',
    done: 'setup.rows.contentStorage.done',
    missing: 'setup.rows.contentStorage.missing',
    attention: 'setup.rows.contentStorage.attention',
    checking: 'setup.rows.checking',
    not_needed: 'setup.rows.notNeeded',
  },
}

/** The secondary list: advisories that used to open as startup dialogs. Only rows with work. */
const also = computed(() =>
  [
    {
      id: 'pipelines',
      labelKey: 'setup.also.pipelines',
      count: pipelineHealth.health.value.length + pipelineHealth.retired.value.length,
      fresh: pipelineHealth.newPipelines.value.length,
      open: () => go(() => ui.openPipelineHealth()),
    },
    {
      id: 'riskPolicies',
      labelKey: 'setup.also.riskPolicies',
      count: riskPolicyHealth.outdated.value.length,
      fresh: riskPolicyHealth.newPresets.value.length,
      open: () => go(() => ui.openRiskPolicyHealth()),
    },
    {
      id: 'modelPresets',
      labelKey: 'setup.also.modelPresets',
      count: modelPresetHealth.outdated.value.length,
      fresh: modelPresetHealth.newPresets.value.length,
      open: () => go(() => ui.openModelPresetHealth()),
    },
  ].filter((row) => row.count + row.fresh > 0),
)
</script>

<template>
  <UModal v-model:open="open" :title="t('setup.title')" :ui="{ content: 'sm:max-w-3xl' }">
    <template #title>
      <span class="flex items-baseline gap-3">
        {{ t('setup.title') }}
        <UBadge color="neutral" variant="subtle" data-testid="setup-progress">
          {{ t('setup.progress', { done: checklist.done, total: checklist.total }) }}
        </UBadge>
      </span>
    </template>
    <template #body>
      <div data-testid="setup-checklist">
        <p class="text-sm text-muted">{{ t('setup.intro') }}</p>

        <UAlert
          v-if="!canAct"
          class="mt-6"
          color="neutral"
          variant="subtle"
          icon="i-lucide-lock"
          :title="t('setup.noAccess.title')"
          :description="t('setup.noAccess.body')"
        />

        <ul v-else class="mt-6 space-y-3">
          <li
            v-for="row in checklist.rows"
            :key="row.id"
            class="flex items-center gap-3 rounded-lg border border-muted bg-default p-4"
            data-testid="setup-row"
            :data-row="row.id"
            :data-status="row.status"
          >
            <UIcon
              :name="STATUS_META[row.status].icon"
              class="h-5 w-5 shrink-0"
              :class="STATUS_META[row.status].class"
            />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-medium text-highlighted">{{ t(ROW_COPY[row.id].title) }}</span>
                <UBadge v-if="row.status !== 'done'" size="sm" color="neutral" variant="outline">
                  {{ row.required ? t('setup.required') : t('setup.optional') }}
                </UBadge>
              </div>
              <p class="mt-0.5 text-xs text-muted">
                {{ t(ROW_COPY[row.id][row.status]) }}
              </p>
            </div>
            <UButton
              v-if="row.status !== 'checking'"
              size="sm"
              :color="row.status === 'done' || row.status === 'not_needed' ? 'neutral' : 'primary'"
              :variant="row.status === 'done' || row.status === 'not_needed' ? 'outline' : 'solid'"
              data-testid="setup-row-action"
              @click="act(row.id)"
            >
              {{ t(STATUS_META[row.status].actionKey) }}
            </UButton>
          </li>
        </ul>

        <template v-if="canAct">
          <USeparator class="my-6" />
          <SectionLabel as="h2" class="mb-3">{{ t('setup.also.title') }}</SectionLabel>
          <ul class="space-y-2 text-sm">
            <li v-for="row in also" :key="row.id" class="flex items-center gap-3">
              <span class="flex-1 text-muted">
                {{ t(row.labelKey, { count: row.count, fresh: row.fresh }) }}
              </span>
              <UButton size="xs" color="neutral" variant="outline" @click="row.open()">
                {{ t('setup.action.review') }}
              </UButton>
            </li>
            <li class="flex flex-wrap items-center gap-2 text-muted">
              <span class="flex-1">{{ t('setup.also.settings') }}</span>
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                @click="go(() => ui.openWorkspaceSettings())"
              >
                {{ t('setup.also.workspaceSettings') }}
              </UButton>
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                @click="go(() => ui.openIntegrations())"
              >
                {{ t('setup.also.integrations') }}
              </UButton>
            </li>
          </ul>
        </template>
      </div>
    </template>
  </UModal>
</template>
