<script setup lang="ts">
// The ONE failure block for a failed "agent run" (a bootstrap or a task execution): a title, a
// one-line cause, one action, and the backend's own text behind a Details toggle. Self-contained:
// it owns the in-flight retry guard and calls the unified retry through the agentRuns store, so
// every surface (board card, queue card, inspector, focus view, service frame) gets the same
// behaviour from one place.
//
// The cause line and the action come from `presentFailure`, keyed by the failure's `kind` and
// `reason`, so they are translated. The backend's `message` and per-kind `hint` explain the
// runtime to the person who operates the deployment, so they are in Details only.
//
// The compact variant (board card, queue card) shows the title and the action only.
import type { EnvironmentFailureReason } from '@cat-factory/contracts'
import type { AgentRunSummary } from '~/stores/agentRuns'
import { presentFailure } from '~/utils/failureCause'
import { conflictInfo } from '~/composables/usePipelineErrorToast'
import FailureNotes from '~/components/board/FailureNotes.vue'
import BootstrapRunSteps from '~/components/bootstrap/BootstrapRunSteps.vue'

const props = withDefaults(
  defineProps<{ run: AgentRunSummary; variant?: 'compact' | 'expanded' }>(),
  { variant: 'expanded' },
)

const { t } = useI18n()
const agentRuns = useAgentRunsStore()
const access = useWorkspaceAccess()
const ui = useUiStore()
const auth = useAuthStore()
const board = useBoardStore()

const compact = computed(() => props.variant === 'compact')
const failure = computed(() => props.run.failure)
const localMode = computed(() => auth.localMode?.enabled === true)
const presented = computed(() =>
  failure.value
    ? presentFailure(failure.value, { runKind: props.run.kind, localMode: localMode.value })
    : null,
)
const action = computed(() => presented.value?.action ?? 'retry')

const DEPLOY_RUNNER_UNWIRED: EnvironmentFailureReason = 'deploy_runner_unwired'
// The toast's entry for a missing repository host: the block's title and Connect button read it,
// so the two surfaces cannot drift.
const GITHUB_NOT_CONNECTED = conflictInfo('github_not_connected')

// The provision type of the failed run's SERVICE frame (walk up to the frame, mirroring the
// backend's `resolveServiceProvisioning`). Drives the Kubernetes-specific hint below.
const provisionType = computed(() => {
  const block = board.getBlock(props.run.blockId)
  return block ? board.serviceOf(block)?.provisioning?.type : undefined
})

// The environment-variable hint is for Kubernetes on a local node only: there the deploy runtime
// is an environment variable, not a settings tab the action could open, so the hint is the fix
// and shows under the cause line, not in Details. Only for the
// machine-readable `deploy_runner_unwired` cause (not a helm/apply error or a temporary fault),
// and only for a `kubernetes` provision, so a later provider with the same cause never shows
// kubectl/kustomize/helm guidance.
const showEnvironmentLocalHint = computed(
  () =>
    localMode.value &&
    failure.value?.kind === 'environment' &&
    failure.value.reason === DEPLOY_RUNNER_UNWIRED &&
    provisionType.value === 'kubernetes',
)

const title = computed(() => {
  // No repository host connected: the same translated title the 409 toast uses.
  if (action.value === 'connectRepoHost') return t(GITHUB_NOT_CONNECTED.titleKey)
  if (failure.value?.kind === 'dispatch') return t('board.failure.containerFailedToStart')
  if (failure.value?.kind === 'environment') return t('board.failure.environmentFailed')
  // The run's durable driver was lost: name it, so it does not read as an agent bug.
  if (failure.value?.kind === 'stalled') return t('board.failure.stalled')
  return props.run.kind === 'bootstrap'
    ? t('board.failure.bootstrapFailed')
    : t('board.failure.runFailed')
})

// A MULTI-STEP bootstrap (the monorepo flow) is not retried from the top: the service resumes
// from the step the run reached, keeping the survey's paid-for reads and, past the review, the
// decisions a human already gave. So the button says which step it re-enters at, from the SAME
// rule the service branches on, rather than "retry", which invites the reviewer to expect to be
// asked for their decisions again. A single-step run has nothing to resume and keeps "retry".
const { resumeStep } = useBootstrapRunSteps(() =>
  props.run.kind === 'bootstrap' ? props.run.runId : null,
)
const retryLabel = computed(() => {
  if (props.run.kind !== 'bootstrap') return t('board.failure.retryRun')
  const step = resumeStep.value
  return step
    ? t('board.failure.resumeBootstrap', { step: t(`bootstrap.steps.name.${step}`) })
    : t('board.failure.retryBootstrap')
})

// The run's own observability panel. Offered here because a failed BOOTSTRAP has no step surface
// to reach it from (a task run's steps each carry their own "Model activity" control), and what
// a bootstrap failed on is exactly the question its model calls, provided context and tool-call
// trajectory answer.
function inspectRun() {
  ui.openObservability(props.run.runId)
}

// The block's action when it is not Retry: the setting that fixes the cause, or a new run when
// a retry cannot work. Retry then moves into Details.
const { startTask } = useStartWithFeedback()
const startingNewRun = ref(false)
async function startNewRun() {
  const block = board.getBlock(props.run.blockId)
  if (!block || startingNewRun.value) return
  startingNewRun.value = true
  try {
    // `startTask` says why in a toast when the start fails.
    await startTask(block)
  } finally {
    startingNewRun.value = false
  }
}

interface OtherAction {
  label: string
  icon: string
  testId: string
  run: () => void
  /** Starting a run needs `runs.execute`, as Retry does; opening a setting does not. */
  executes: boolean
}
const otherAction = computed((): OtherAction | null => {
  switch (action.value) {
    case 'connectRepoHost': {
      const fix = GITHUB_NOT_CONNECTED.action
      return fix
        ? {
            label: t(fix.labelKey),
            icon: fix.icon,
            testId: 'agent-failure-setup',
            run: () => fix.run(ui),
            executes: false,
          }
        : null
    }
    case 'runnerPoolSetup':
      return {
        label: t('board.failure.deployRunnerSetup'),
        icon: 'i-lucide-settings',
        testId: 'agent-failure-setup',
        run: () => ui.openProviderConnection('runner-pool'),
        executes: false,
      }
    case 'environmentSetup':
      return {
        label: t('board.failure.environmentSetup'),
        icon: 'i-lucide-settings',
        testId: 'agent-failure-setup',
        run: () => ui.openProviderConnection('environment'),
        executes: false,
      }
    case 'newRun':
      return {
        label: t('board.failure.startNewRun'),
        icon: 'i-lucide-play',
        testId: 'agent-failure-new-run',
        run: () => void startNewRun(),
        executes: true,
      }
    case 'retry':
      return null
  }
})
const otherActionDenied = computed(
  () => !!otherAction.value?.executes && !access.canExecuteRuns.value,
)

const detailsOpen = ref(false)

const retrying = ref(false)
async function retry() {
  if (retrying.value) return
  retrying.value = true
  try {
    // The store surfaces any failure as an actionable toast (incl. the no-provider 409),
    // so we only need to clear the in-flight guard here.
    await agentRuns.retry(props.run.runId)
  } finally {
    retrying.value = false
  }
}
</script>

<template>
  <div
    class="nodrag rounded-lg border border-app-error-900/60 bg-app-error-950/40"
    :class="compact ? 'px-3 py-2' : 'px-3 py-2.5'"
    data-testid="agent-failure-banner"
    :data-run-kind="run.kind"
    :data-failure-action="action"
  >
    <div class="flex items-center gap-1.5" :class="compact ? 'text-2xs' : 'text-xs'">
      <UIcon
        name="i-lucide-alert-triangle"
        class="shrink-0 text-app-error-400"
        :class="compact ? 'h-3.5 w-3.5' : 'h-4 w-4'"
      />
      <span class="font-medium text-app-error-300">{{ title }}</span>
    </div>

    <p
      v-if="!compact && presented"
      class="mt-1 text-2xs leading-snug text-app-error-200/90"
      data-testid="agent-failure-cause"
    >
      {{ t(presented.causeKey) }}
    </p>

    <!-- Local mode, Kubernetes: the deploy runtime is an environment variable, not a settings tab,
         so the variables to set are the fix and show here, not in Details. -->
    <p
      v-if="!compact && showEnvironmentLocalHint"
      class="mt-1 text-2xs leading-snug text-app-error-200/90"
      data-testid="agent-failure-environment-local-hint"
    >
      {{
        t('board.failure.environmentLocalHint', {
          runtime: 'LOCAL_DEPLOY_RUNTIME',
          native: 'LOCAL_DEPLOY_HARNESS_ENTRY',
          container: 'LOCAL_DEPLOY_IMAGE',
        })
      }}
    </p>

    <!-- Which of the run's steps it got to. Renders for a multi-step (monorepo) bootstrap only;
         see BootstrapRunSteps. -->
    <BootstrapRunSteps
      v-if="!compact && run.kind === 'bootstrap'"
      :run-id="run.runId"
      class="mt-2"
    />

    <div class="flex flex-wrap items-center gap-2" :class="compact ? 'mt-1.5' : 'mt-2'">
      <UButton
        v-if="otherAction"
        color="error"
        variant="soft"
        size="xs"
        class="nodrag"
        :icon="otherAction.icon"
        :loading="otherAction.executes && startingNewRun"
        :disabled="otherActionDenied"
        :title="otherActionDenied ? t('access.noRunExecute') : undefined"
        :data-testid="otherAction.testId"
        @click.stop="otherAction.run"
      >
        {{ otherAction.label }}
      </UButton>
      <UButton
        v-else
        color="error"
        variant="soft"
        size="xs"
        class="nodrag"
        icon="i-lucide-rotate-ccw"
        :loading="retrying"
        :disabled="!access.canExecuteRuns.value"
        :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
        data-testid="agent-failure-retry"
        @click.stop="retry"
      >
        {{ retrying ? t('board.failure.retrying') : compact ? t('common.retry') : retryLabel }}
      </UButton>

      <UButton
        v-if="!compact && failure"
        variant="link"
        color="neutral"
        size="xs"
        class="nodrag text-app-error-400/80 hover:text-app-error-300"
        :icon="detailsOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
        :aria-expanded="detailsOpen"
        data-testid="agent-failure-details-toggle"
        @click.stop="detailsOpen = !detailsOpen"
      >
        {{ t('board.failure.details') }}
      </UButton>
    </div>

    <FailureNotes v-if="!compact && failure && detailsOpen" :failure="failure" tone="error">
      <div v-if="otherAction || run.kind === 'bootstrap'" class="flex flex-wrap items-center gap-2">
        <!-- Retry is the block's action unless a setting fixes the cause or the run must start
             again; then it waits here. -->
        <UButton
          v-if="otherAction"
          color="neutral"
          variant="ghost"
          size="xs"
          class="nodrag"
          icon="i-lucide-rotate-ccw"
          :loading="retrying"
          :disabled="!access.canExecuteRuns.value"
          :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
          data-testid="agent-failure-retry"
          @click.stop="retry"
        >
          {{ retrying ? t('board.failure.retrying') : retryLabel }}
        </UButton>
        <!-- A failed bootstrap has no step surface to reach its model calls from, and what it
             failed on is the question its calls answer. -->
        <UButton
          v-if="run.kind === 'bootstrap'"
          color="neutral"
          variant="ghost"
          size="xs"
          class="nodrag"
          icon="i-lucide-activity"
          data-testid="agent-failure-inspect"
          @click.stop="inspectRun"
        >
          {{ t('observability.modelActivity') }}
        </UButton>
      </div>
    </FailureNotes>
  </div>
</template>
