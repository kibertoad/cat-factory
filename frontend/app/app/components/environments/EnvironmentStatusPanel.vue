<script setup lang="ts">
// Reusable read-only view of an ephemeral environment's lifecycle: a status badge,
// the live URL, the TTL, and — when it failed/expired — the verbatim provider error.
// Used in a run's details (AgentStepDetail) so the Tester (and any env-consuming step)
// shows whether the env is spinning up / running / shut down / errored, with the error.
import type { InfraEngine, ProvisionType } from '@cat-factory/contracts'
import type { RunEnvironment, HumanTestEnvironmentStatus } from '~/types/execution'

const props = defineProps<{ environment: RunEnvironment | null; degradedReason?: string | null }>()

const { t, d } = useI18n()

// Exhaustive enum→key maps (keep the typed-key drift guard live) for the resolved
// provision type + engine recorded on the handle, so run details state exactly what was
// stood up and how. `infraless`/`none` are filtered out of the display below.
const PROVISION_TYPE_KEYS: Record<ProvisionType, string> = {
  kubernetes: 'environments.provisionType.kubernetes',
  'docker-compose': 'environments.provisionType.docker-compose',
  custom: 'environments.provisionType.custom',
  infraless: 'environments.provisionType.infraless',
}
const ENGINE_KEYS: Record<InfraEngine, string> = {
  'local-docker': 'environments.engine.local-docker',
  'local-k3s': 'environments.engine.local-k3s',
  'remote-kubernetes': 'environments.engine.remote-kubernetes',
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
    color: 'text-amber-300',
    icon: 'i-lucide-loader-circle',
  },
  ready: {
    label: t('environments.status.ready'),
    color: 'text-emerald-300',
    icon: 'i-lucide-circle-dot',
  },
  failed: {
    label: t('environments.status.failed'),
    color: 'text-rose-300',
    icon: 'i-lucide-circle-alert',
  },
  expired: {
    label: t('environments.status.expired'),
    color: 'text-slate-400',
    icon: 'i-lucide-circle-off',
  },
  tearing_down: {
    label: t('environments.status.tearing_down'),
    color: 'text-slate-400',
    icon: 'i-lucide-loader-circle',
  },
  torn_down: {
    label: t('environments.status.torn_down'),
    color: 'text-slate-400',
    icon: 'i-lucide-circle-off',
  },
}))
</script>

<template>
  <section class="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
    <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
      {{ t('environments.title') }}
    </h3>
    <div v-if="environment" class="space-y-2">
      <div class="flex items-center gap-2 text-[13px]">
        <UIcon
          :name="ENV_STATUS_META[environment.status].icon"
          class="h-3.5 w-3.5"
          :class="[
            ENV_STATUS_META[environment.status].color,
            {
              'animate-spin':
                environment.status === 'provisioning' || environment.status === 'tearing_down',
            },
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
        class="inline-flex items-center gap-1.5 break-all text-[13px] text-sky-300 hover:underline"
      >
        <UIcon name="i-lucide-external-link" class="h-3.5 w-3.5 shrink-0" />
        {{ environment.url }}
      </a>
      <p v-if="environment.expiresAt" class="text-[11px] text-slate-500">
        {{ t('environments.expires', { date: d(new Date(environment.expiresAt), 'long') }) }}
      </p>
      <!-- The resolved provision type + engine recorded at provision time, so a run states
           exactly what was provisioned and how (the what/where ÷ how split). -->
      <dl v-if="provisionTypeLabel || engineLabel" class="flex flex-wrap gap-x-4 gap-y-0.5">
        <div v-if="provisionTypeLabel" class="flex items-center gap-1 text-[11px]">
          <dt class="text-slate-500">{{ t('environments.provisionTypeLabel') }}</dt>
          <dd class="text-slate-300">{{ provisionTypeLabel }}</dd>
        </div>
        <div v-if="engineLabel" class="flex items-center gap-1 text-[11px]">
          <dt class="text-slate-500">{{ t('environments.engineLabel') }}</dt>
          <dd class="text-slate-300">{{ engineLabel }}</dd>
        </div>
      </dl>
      <!-- The verbatim provider error when the environment failed/expired. -->
      <pre
        v-if="
          environment.lastError &&
          (environment.status === 'failed' || environment.status === 'expired')
        "
        class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded border border-rose-900/60 bg-rose-950/40 p-1.5 text-[11px] text-rose-200/90"
        >{{ environment.lastError }}</pre
      >
    </div>
    <p v-else class="text-[12px] text-slate-500">
      {{ degradedReason ?? t('environments.empty') }}
    </p>
  </section>
</template>
