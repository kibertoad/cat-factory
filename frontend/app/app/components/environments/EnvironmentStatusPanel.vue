<script setup lang="ts">
// Reusable read-only view of an ephemeral environment's lifecycle: a status badge,
// the live URL, the TTL, and — when it failed/expired — the verbatim provider error.
// Used in a run's details (AgentStepDetail) so the Tester (and any env-consuming step)
// shows whether the env is spinning up / running / shut down / errored, with the error.
import type { InfraEngine, ProvisionType } from '@cat-factory/contracts'
import type { RunEnvironment, HumanTestEnvironmentStatus } from '~/types/execution'
import {
  readStatusNote,
  showsProviderFailure,
} from '~/components/environments/EnvironmentStatusPanel.logic'
import SectionLabel from '~/components/common/SectionLabel.vue'

const props = defineProps<{
  environment: RunEnvironment | null
  /**
   * Whether the enclosing run is still being driven (`runIsActive`). A transitional status
   * (`provisioning` / `tearing_down`) keeps its label once the run stops, because that is the
   * last thing the provider reported, but its icon stops spinning: nothing is standing this
   * environment up any more. Required rather than defaulted so a new call site has to say which
   * run it is rendering, instead of silently inheriting a perpetual spinner.
   */
  runActive: boolean
  degradedReason?: string | null
}>()

const { t, d } = useI18n()

// Exhaustive enum→key maps (keep the typed-key drift guard live) for the resolved
// provision type + engine recorded on the handle, so run details state exactly what was
// stood up and how. `infraless`/`none` are filtered out of the display below.
const PROVISION_TYPE_KEYS: Record<ProvisionType, string> = {
  kubernetes: 'environments.provisionType.kubernetes',
  'docker-compose': 'environments.provisionType.docker-compose',
  cloudflare: 'environments.provisionType.cloudflare',
  custom: 'environments.provisionType.custom',
  infraless: 'environments.provisionType.infraless',
}
const ENGINE_KEYS: Record<InfraEngine, string> = {
  'local-docker': 'environments.engine.local-docker',
  'local-k3s': 'environments.engine.local-k3s',
  'remote-kubernetes': 'environments.engine.remote-kubernetes',
  cloudflare: 'environments.engine.cloudflare',
  'remote-custom': 'environments.engine.remote-custom',
  none: 'environments.engine.none',
}

const provisionTypeLabel = computed(() => {
  const pt = props.environment?.provisionType
  return pt ? t(PROVISION_TYPE_KEYS[pt]) : null
})
const engineLabel = computed(() => {
  const e = props.environment?.engine
  return e && e !== 'none' ? t(ENGINE_KEYS[e]) : null
})

// Exhaustive enum→label map of literal `t(...)` keys (keeps the typed-key drift guard
// live); the color/icon stay static, English-neutral styling.
const ENV_STATUS_META = computed<
  Record<HumanTestEnvironmentStatus, { label: string; color: string; icon: string }>
>(() => ({
  provisioning: {
    label: t('environments.status.provisioning'),
    color: 'text-app-warning-300',
    icon: 'i-lucide-loader-circle',
  },
  ready: {
    label: t('environments.status.ready'),
    color: 'text-app-success-300',
    icon: 'i-lucide-circle-dot',
  },
  failed: {
    label: t('environments.status.failed'),
    color: 'text-app-error-300',
    icon: 'i-lucide-circle-alert',
  },
  expired: {
    label: t('environments.status.expired'),
    color: 'text-muted',
    icon: 'i-lucide-circle-off',
  },
  tearing_down: {
    label: t('environments.status.tearing_down'),
    color: 'text-muted',
    icon: 'i-lucide-loader-circle',
  },
  torn_down: {
    label: t('environments.status.torn_down'),
    color: 'text-muted',
    icon: 'i-lucide-circle-off',
  },
}))

// Which of the environment's two prose channels this panel shows. Both predicates live in
// `EnvironmentStatusPanel.logic.ts`, where the precedence between a recorded fault and a
// still-coming-up note is stated once and asserted without mounting the panel.
const failureShown = computed(() => showsProviderFailure(props.environment))
const statusNote = computed(() => readStatusNote(props.environment))

// The two statuses that describe a transition IN FLIGHT. Only these ever animate, and only
// while the run driving the transition is still being driven itself.
const envInTransition = computed(
  () =>
    props.environment?.status === 'provisioning' || props.environment?.status === 'tearing_down',
)
</script>

<template>
  <section class="rounded-lg border border-default bg-default/60 p-3">
    <SectionLabel as="h3" class="mb-2">
      {{ t('environments.title') }}
    </SectionLabel>
    <div v-if="environment" class="space-y-2">
      <div class="flex items-center gap-2 text-sm">
        <UIcon
          :name="ENV_STATUS_META[environment.status].icon"
          class="h-3.5 w-3.5"
          :class="[
            ENV_STATUS_META[environment.status].color,
            { 'animate-spin': runActive && envInTransition },
          ]"
        />
        <span :class="ENV_STATUS_META[environment.status].color">{{
          ENV_STATUS_META[environment.status].label
        }}</span>
      </div>
      <a
        v-if="environment.url"
        :href="environment.url"
        target="_blank"
        rel="noopener"
        class="inline-flex items-center gap-1.5 break-all text-sm text-app-info-300 hover:underline"
      >
        <UIcon name="i-lucide-external-link" class="h-3.5 w-3.5 shrink-0" />
        {{ environment.url }}
      </a>
      <p v-if="environment.expiresAt" class="text-2xs text-dimmed">
        {{ t('environments.expires', { date: d(new Date(environment.expiresAt), 'long') }) }}
      </p>
      <!-- The resolved provision type + engine recorded at provision time, so a run states
           exactly what was provisioned and how (the what/where ÷ how split). -->
      <dl v-if="provisionTypeLabel || engineLabel" class="flex flex-wrap gap-x-4 gap-y-0.5">
        <div v-if="provisionTypeLabel" class="flex items-center gap-1 text-2xs">
          <dt class="text-dimmed">{{ t('environments.provisionTypeLabel') }}</dt>
          <dd class="text-toned">{{ provisionTypeLabel }}</dd>
        </div>
        <div v-if="engineLabel" class="flex items-center gap-1 text-2xs">
          <dt class="text-dimmed">{{ t('environments.engineLabel') }}</dt>
          <dd class="text-toned">{{ engineLabel }}</dd>
        </div>
      </dl>
      <!-- The verbatim provider error when the environment failed/expired. -->
      <pre
        v-if="failureShown"
        class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded border border-app-error-900/60 bg-app-error-950/40 p-1.5 text-2xs text-app-error-200/90"
        >{{ environment.lastError }}</pre>
      <!-- What the provider says it is still waiting on. Muted rather than alarming: an
           environment mid-rollout is healthy, and styling this like the error above would report
           a fault every deploy. Bounded like the error block, because the text is provider
           prose. -->
      <p
        v-if="statusNote"
        class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-2xs text-muted"
      >
        {{ t('environments.statusNote', { note: statusNote }) }}
      </p>
    </div>
    <p v-else class="text-xs text-dimmed">
      {{ degradedReason ?? t('environments.empty') }}
    </p>
  </section>
</template>
