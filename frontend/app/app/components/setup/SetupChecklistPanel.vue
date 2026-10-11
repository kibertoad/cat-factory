<script setup lang="ts">
import type { SetupRow, SetupRowCause, SetupRowId, SetupRowStatus } from '~/utils/setupChecklist'
import type { SetupRemedy } from '~/utils/setupAudience'
import SectionLabel from '~/components/common/SectionLabel.vue'
import Spinner from '~/components/common/Spinner.vue'

/**
 * The setup checklist: every prerequisite for "a task can run and merge", its state, and one
 * action per row (issue #2258).
 *
 * The probes and the surfaces each row opens are the ones the setup banners, the AI-provider
 * dialogs and the startup health advisories already use (`useSetupChecklist`), and so is the rule
 * for who may act: a row the caller cannot fix shows who can instead of a button. What it adds is
 * the whole list in one place, with a finish line, instead of one interruption per missing piece.
 * Opening a row's surface closes the checklist, so the two never stack.
 */
const { t } = useI18n()
const ui = useUiStore()
const { checklist, actionFor, refresh, patSource, patMissing } = useSetupChecklist()

const open = computed({
  get: () => ui.setupChecklistOpen,
  set: (v: boolean) => (v ? ui.openSetupChecklist() : ui.closeSetupChecklist()),
})
watch(
  () => ui.setupChecklistOpen,
  (isOpen) => {
    if (isOpen) refresh()
  },
  { immediate: true },
)

/** Open a surface from the checklist: close the checklist first, so the two never stack. */
function go(fn: () => void) {
  ui.closeSetupChecklist()
  fn()
}
function act(row: SetupRow) {
  const action = actionFor(row)
  if (!action) return
  // Asking a probe again keeps the checklist open: its answer lands here.
  if (row.cause === 'probeFailed') action()
  else go(action)
}

/** The rows this caller can act on, with the action to show. */
function canAct(row: SetupRow): boolean {
  return row.remedy === null && actionFor(row) !== null
}

/**
 * The ONE solid button in the view: the first required row that is not done and that this caller
 * can act on. Every other open row takes a lighter variant, so the list reads in order.
 */
const primaryRowId = computed<SetupRowId | null>(
  () =>
    checklist.value.rows.find(
      (r) => r.required && (r.status === 'missing' || r.status === 'attention') && canAct(r),
    )?.id ?? null,
)

const pipelineHealth = usePipelineHealth()
const riskPolicyHealth = useRiskPolicyHealth()
const modelPresetHealth = useModelPresetHealth()

const STATUS_META: Record<SetupRowStatus, { icon: string; class: string }> = {
  done: { icon: 'i-lucide-circle-check', class: 'text-success' },
  missing: { icon: 'i-lucide-circle', class: 'text-dimmed' },
  attention: { icon: 'i-lucide-circle-alert', class: 'text-warning' },
  checking: { icon: 'i-lucide-loader-circle', class: 'text-dimmed' },
  not_needed: { icon: 'i-lucide-circle-minus', class: 'text-dimmed' },
}

/**
 * The action's word per state. Null for the two states that never carry an action
 * (`useSetupChecklist.actionFor`), so no copy ships for a button that cannot render.
 */
const ACTION_KEYS: Record<SetupRowStatus, string | null> = {
  done: 'setup.action.change',
  missing: 'setup.action.connect',
  attention: 'setup.action.fix',
  checking: null,
  not_needed: null,
}

function actionLabel(row: SetupRow): string {
  if (row.cause === 'probeFailed') return t('setup.action.retry')
  const key = ACTION_KEYS[row.status]
  return key ? t(key) : ''
}

/** Whose token a token row is about: the remedy differs, so the row says it, as the banner does. */
const patSourceKey = computed(() =>
  patSource.value === 'deployment'
    ? 'layout.githubPatPermissionsBanner.sourceDeployment'
    : 'layout.githubPatPermissionsBanner.sourceInitiator',
)

/**
 * Each row's title and its line for the states that are about the row. An `attention` row's line
 * is its CAUSE (`CAUSE_KEYS`): the title already names the area, and each cause needs its own fix.
 */
const ROW_COPY: Record<
  SetupRowId,
  { title: string } & Record<Exclude<SetupRowStatus, 'attention'>, string>
> = {
  model: {
    title: 'setup.rows.model.title',
    done: 'setup.rows.model.done',
    missing: 'setup.rows.model.missing',
    checking: 'setup.rows.checking',
    not_needed: 'setup.rows.notNeeded',
  },
  sourceControl: {
    title: 'setup.rows.sourceControl.title',
    done: 'setup.rows.sourceControl.done',
    missing: 'setup.rows.sourceControl.missing',
    checking: 'setup.rows.checking',
    not_needed: 'setup.rows.notNeeded',
  },
  agentExecutor: {
    title: 'setup.rows.agentExecutor.title',
    done: 'setup.rows.agentExecutor.done',
    missing: 'setup.rows.agentExecutor.missing',
    checking: 'setup.rows.checking',
    not_needed: 'setup.rows.agentExecutor.notNeeded',
  },
  ephemeralEnvironments: {
    title: 'setup.rows.ephemeralEnvironments.title',
    done: 'setup.rows.ephemeralEnvironments.done',
    missing: 'setup.rows.ephemeralEnvironments.missing',
    checking: 'setup.rows.checking',
    not_needed: 'setup.rows.notNeeded',
  },
  binaryStorage: {
    title: 'setup.rows.binaryStorage.title',
    done: 'setup.rows.binaryStorage.done',
    missing: 'setup.rows.binaryStorage.missing',
    checking: 'setup.rows.checking',
    not_needed: 'setup.rows.notNeeded',
  },
}
const CAUSE_KEYS: Record<SetupRowCause, string> = {
  unreachable: 'setup.causes.unreachable',
  incomplete: 'setup.causes.incomplete',
  rejected: 'setup.causes.rejected',
  underscoped: 'setup.causes.underscoped',
  presetBroken: 'setup.causes.presetBroken',
  probeFailed: 'setup.causes.probeFailed',
  notReported: 'setup.causes.notReported',
}
function rowLine(row: SetupRow): string {
  return row.status === 'attention' ? t(CAUSE_KEYS[row.cause]) : t(ROW_COPY[row.id][row.status])
}

// The same "who can fix this" lines the infrastructure notice shows a caller who cannot act.
const REMEDY_KEYS: Record<SetupRemedy, string> = {
  workspace_admin: 'layout.infraSetupNotice.owner.workspace_admin',
  account_admin: 'layout.infraSetupNotice.owner.account_admin',
  operator: 'layout.infraSetupNotice.owner.operator',
  full_surface: 'layout.infraSetupNotice.fullSurface',
}

/**
 * The secondary list: advisories that used to open as startup dialogs, each count on its own so
 * no sentence has to agree with a number. Only rows with work.
 */
const also = computed(() =>
  [
    {
      id: 'pipelines',
      labelKey: 'setup.also.pipelines',
      counts: [
        {
          key: 'setup.also.counts.repair',
          n:
            pipelineHealth.health.value.filter((h) => h.invalid).length +
            pipelineHealth.retired.value.length,
        },
        {
          key: 'setup.also.counts.outdated',
          n: pipelineHealth.health.value.filter((h) => !h.invalid && h.outdated).length,
        },
        { key: 'setup.also.counts.new', n: pipelineHealth.newPipelines.value.length },
      ],
      open: () => go(() => ui.openPipelineHealth()),
    },
    {
      id: 'riskPolicies',
      labelKey: 'setup.also.riskPolicies',
      counts: [
        { key: 'setup.also.counts.outdated', n: riskPolicyHealth.outdated.value.length },
        { key: 'setup.also.counts.new', n: riskPolicyHealth.newPresets.value.length },
      ],
      open: () => go(() => ui.openRiskPolicyHealth()),
    },
    {
      id: 'modelPresets',
      labelKey: 'setup.also.modelPresets',
      counts: [
        { key: 'setup.also.counts.outdated', n: modelPresetHealth.outdated.value.length },
        { key: 'setup.also.counts.new', n: modelPresetHealth.newPresets.value.length },
      ],
      open: () => go(() => ui.openModelPresetHealth()),
    },
  ]
    .map((row) => ({ ...row, counts: row.counts.filter((c) => c.n > 0) }))
    .filter((row) => row.counts.length > 0),
)
</script>

<template>
  <UModal v-model:open="open" :title="t('setup.title')" :ui="{ content: 'sm:max-w-3xl' }">
    <template #title>
      <span class="flex items-baseline gap-3">
        {{ t('setup.title') }}
        <!-- While a probe has not answered, the count is not one yet, so the badge says so. -->
        <UBadge color="neutral" variant="subtle" data-testid="setup-progress">
          {{
            checklist.checking
              ? t('setup.rows.checking')
              : t('setup.progress', { done: checklist.done, total: checklist.total })
          }}
        </UBadge>
      </span>
    </template>
    <template #body>
      <div data-testid="setup-checklist">
        <p class="text-sm text-muted">{{ t('setup.intro') }}</p>

        <ul class="mt-6 space-y-3">
          <li
            v-for="row in checklist.rows"
            :key="row.id"
            class="flex items-center gap-3 rounded-lg border border-muted bg-default p-4"
            data-testid="setup-row"
            :data-row="row.id"
            :data-status="row.status"
            :data-cause="row.cause ?? undefined"
            :data-remedy="row.remedy ?? undefined"
          >
            <Spinner
              :name="STATUS_META[row.status].icon"
              :spinning="row.status === 'checking'"
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
              <p class="mt-0.5 text-xs text-muted">{{ rowLine(row) }}</p>
              <!-- The token rows carry the banners' second half: whose token it is, and, for a
                   missing local token, where the new one goes. -->
              <p
                v-if="row.cause === 'rejected' || row.cause === 'underscoped'"
                class="mt-0.5 text-xs text-dimmed"
              >
                {{ t(patSourceKey) }}
              </p>
              <p
                v-else-if="row.id === 'sourceControl' && row.status === 'missing' && patMissing"
                class="mt-0.5 text-xs text-dimmed"
              >
                <i18n-t keypath="layout.githubPatBanner.thenSet" tag="span" scope="global">
                  <template #envVar>
                    <code class="font-mono">GITHUB_PAT</code>
                  </template>
                </i18n-t>
              </p>
              <!-- A gap this caller cannot close: who can, in place of a button their save would
                   be refused on. A done row needs neither. -->
              <p
                v-if="row.remedy && row.status !== 'done' && row.status !== 'not_needed'"
                class="mt-0.5 text-xs text-dimmed"
                data-testid="setup-row-remedy"
              >
                {{ t(REMEDY_KEYS[row.remedy]) }}
              </p>
            </div>
            <UButton
              v-if="canAct(row)"
              size="sm"
              :color="row.status === 'done' ? 'neutral' : 'primary'"
              :variant="
                row.id === primaryRowId ? 'solid' : row.status === 'done' ? 'outline' : 'soft'
              "
              data-testid="setup-row-action"
              @click="act(row)"
            >
              {{ actionLabel(row) }}
            </UButton>
          </li>
        </ul>

        <USeparator class="my-6" />
        <SectionLabel as="h2" class="mb-3">{{ t('setup.also.title') }}</SectionLabel>
        <ul class="space-y-2 text-sm">
          <li v-for="row in also" :key="row.id" class="flex flex-wrap items-center gap-2">
            <span class="text-muted">{{ t(row.labelKey) }}</span>
            <UBadge v-for="c in row.counts" :key="c.key" size="sm" color="neutral" variant="subtle">
              {{ t(c.key, { count: c.n }) }}
            </UBadge>
            <UButton
              class="ms-auto"
              size="xs"
              color="neutral"
              variant="outline"
              @click="row.open()"
            >
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
      </div>
    </template>
  </UModal>
</template>
