<script setup lang="ts">
// Shared failure banner + retry for any failed "agent run" (a bootstrap or a
// task execution). Self-contained: it owns the in-flight retry guard and calls
// the unified retry through the agentRuns store, so every surface (board card,
// inspector, task panel) gets identical behaviour from one place. Replaces the
// three hand-rolled bootstrap banners that used to duplicate this logic.
import type { EnvironmentFailureReason } from '@cat-factory/contracts'
import type { AgentRunSummary } from '~/stores/agentRuns'
import FailureDetail from '~/components/board/FailureDetail.vue'

const props = withDefaults(
  defineProps<{ run: AgentRunSummary; variant?: 'compact' | 'expanded' }>(),
  { variant: 'expanded' },
)

const { t } = useI18n()
const agentRuns = useAgentRunsStore()
const ui = useUiStore()
const auth = useAuthStore()
const board = useBoardStore()

const compact = computed(() => props.variant === 'compact')
const failure = computed(() => props.run.failure)
// An `environment` failure is a provisioning/config problem, so offer a one-click jump to the
// place it's configured (Infrastructure → Test environments) alongside the retry — the same
// "Configure…" deep-link pattern the infra-setup banners use.
const isEnvironmentFailure = computed(() => failure.value?.kind === 'environment')
function openEnvironmentConfig() {
  ui.openProviderConnection('environment')
}

// The provision type of the failed run's SERVICE frame (walk up to the frame, mirroring the
// backend's `resolveServiceProvisioning`). Drives the K8s-specific gate below.
const provisionType = computed(() => {
  const block = board.getBlock(props.run.blockId)
  return block ? board.serviceOf(block)?.provisioning?.type : undefined
})

// The env-var hint is Kubernetes+local specific, so gate it precisely rather than showing it for
// every environment failure: only for the machine-readable `deploy_runner_unwired` cause (NOT a
// helm/apply error or a transient blip), only in local mode (where the deploy runtime is an env
// var, not a UI connection the tab could fix), and only for a `kubernetes` provision (so a future
// Nomad/custom provider triggering the same cause never shows kubectl/kustomize/helm guidance).
const DEPLOY_RUNNER_UNWIRED: EnvironmentFailureReason = 'deploy_runner_unwired'
const showEnvironmentLocalHint = computed(
  () =>
    isEnvironmentFailure.value &&
    auth.localMode?.enabled === true &&
    failure.value?.reason === DEPLOY_RUNNER_UNWIRED &&
    provisionType.value === 'kubernetes',
)
const title = computed(() => {
  // A `dispatch` failure means the container/runner never accepted the job — say so
  // explicitly rather than the generic "Run failed", and show the verbatim provider
  // error in the collapsible detail below.
  if (failure.value?.kind === 'dispatch') return t('board.failure.containerFailedToStart')
  // An `environment` failure means the deployer's EnvironmentProvider could not provision —
  // name it, with the provider's verbatim error in the collapsible detail below.
  if (failure.value?.kind === 'environment') return t('board.failure.environmentFailed')
  // A `stalled` failure means the run's durable driver was lost (crashed/restarted
  // orchestrator) and recovery couldn't resume it — name it so it doesn't read as an agent bug.
  if (failure.value?.kind === 'stalled') return t('board.failure.stalled')
  return props.run.kind === 'bootstrap'
    ? t('board.failure.bootstrapFailed')
    : t('board.failure.runFailed')
})
const retryLabel = computed(() =>
  props.run.kind === 'bootstrap' ? t('board.failure.retryBootstrap') : t('board.failure.retryRun'),
)

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
    class="nodrag rounded-lg border border-rose-900/60 bg-rose-950/40"
    :class="compact ? 'px-3 py-2' : 'px-3 py-2.5'"
    data-testid="agent-failure-banner"
    :data-run-kind="run.kind"
  >
    <div class="flex items-center gap-1.5" :class="compact ? 'text-[11px]' : 'text-xs'">
      <UIcon
        name="i-lucide-alert-triangle"
        class="shrink-0 text-rose-400"
        :class="compact ? 'h-3.5 w-3.5' : 'h-4 w-4'"
      />
      <span class="text-rose-300">{{ title }}</span>
    </div>

    <p
      v-if="failure?.message"
      class="mt-1 leading-snug text-rose-300/90"
      :class="compact ? 'line-clamp-2 text-[10px]' : 'text-[11px]'"
      :title="failure.message"
    >
      {{ failure.message }}
    </p>

    <p
      v-if="failure?.hint"
      class="mt-1 leading-snug text-rose-400/70"
      :class="compact ? 'text-[10px]' : 'text-[11px]'"
    >
      {{ failure.hint }}
    </p>

    <!-- Local mode only: the deploy runtime is configured via env vars, not a UI connection, so
         name the concrete .env fix rather than only pointing at the (unhelpful-here) tab. -->
    <p
      v-if="showEnvironmentLocalHint && !compact"
      class="mt-1 text-[11px] leading-snug text-rose-400/70"
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

    <FailureDetail
      v-if="!compact && failure"
      :detail="failure.detail"
      :message="failure.message"
      summary-class="text-[10px] text-rose-400/60 hover:text-rose-300"
      pre-class="bg-rose-950/60 text-[10px] text-rose-200/80"
    />

    <div class="mt-2 flex flex-wrap items-center gap-2">
      <button
        type="button"
        class="nodrag flex items-center gap-1 rounded-md bg-rose-900/40 text-rose-200 hover:bg-rose-900/70 disabled:opacity-60"
        :class="compact ? 'px-2 py-0.5 text-[10px]' : 'px-2 py-1 text-[11px]'"
        :disabled="retrying"
        data-testid="agent-failure-retry"
        @click.stop="retry"
      >
        <UIcon
          :name="retrying ? 'i-lucide-loader-circle' : 'i-lucide-rotate-ccw'"
          :class="[compact ? 'h-3 w-3' : 'h-3.5 w-3.5', { 'animate-spin': retrying }]"
        />
        {{ retrying ? t('board.failure.retrying') : compact ? t('common.retry') : retryLabel }}
      </button>

      <!-- Environment provisioning failures are almost always a deploy-backend / provider-config
           issue, so link straight to where it's set up rather than leaving the user to hunt. -->
      <button
        v-if="isEnvironmentFailure"
        type="button"
        class="nodrag flex items-center gap-1 rounded-md bg-rose-900/20 text-rose-300 hover:bg-rose-900/50"
        :class="compact ? 'px-2 py-0.5 text-[10px]' : 'px-2 py-1 text-[11px]'"
        data-testid="agent-failure-configure-environment"
        @click.stop="openEnvironmentConfig"
      >
        <UIcon name="i-lucide-settings" :class="compact ? 'h-3 w-3' : 'h-3.5 w-3.5'" />
        {{ t('board.failure.environmentSetup') }}
      </button>
    </div>
  </div>
</template>
