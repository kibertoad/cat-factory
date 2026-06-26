<script setup lang="ts">
// Reusable read-only view of an ephemeral environment's lifecycle: a status badge,
// the live URL, the TTL, and — when it failed/expired — the verbatim provider error.
// Used in a run's details (AgentStepDetail) so the Tester (and any env-consuming step)
// shows whether the env is spinning up / running / shut down / errored, with the error.
import type { RunEnvironment, HumanTestEnvironmentStatus } from '~/types/execution'

defineProps<{ environment: RunEnvironment | null; degradedReason?: string | null }>()

const ENV_STATUS_META: Record<
  HumanTestEnvironmentStatus,
  { label: string; color: string; icon: string }
> = {
  provisioning: { label: 'Spinning up…', color: 'text-amber-300', icon: 'i-lucide-loader-circle' },
  ready: { label: 'Running', color: 'text-emerald-300', icon: 'i-lucide-circle-dot' },
  failed: { label: 'Errored', color: 'text-rose-300', icon: 'i-lucide-circle-alert' },
  expired: { label: 'Expired', color: 'text-slate-400', icon: 'i-lucide-circle-off' },
  tearing_down: { label: 'Shutting down…', color: 'text-slate-400', icon: 'i-lucide-loader-circle' },
  torn_down: { label: 'Shut down', color: 'text-slate-400', icon: 'i-lucide-circle-off' },
}
</script>

<template>
  <section class="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
    <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
      Ephemeral environment
    </h3>
    <div v-if="environment" class="space-y-2">
      <div class="flex items-center gap-2 text-[13px]">
        <UIcon
          :name="ENV_STATUS_META[environment.status].icon"
          class="h-3.5 w-3.5"
          :class="[
            ENV_STATUS_META[environment.status].color,
            { 'animate-spin': environment.status === 'provisioning' || environment.status === 'tearing_down' },
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
        Expires {{ new Date(environment.expiresAt).toLocaleString() }}
      </p>
      <!-- The verbatim provider error when the environment failed/expired. -->
      <pre
        v-if="environment.lastError && (environment.status === 'failed' || environment.status === 'expired')"
        class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded border border-rose-900/60 bg-rose-950/40 p-1.5 text-[11px] text-rose-200/90"
        >{{ environment.lastError }}</pre
      >
    </div>
    <p v-else class="text-[12px] text-slate-500">
      {{ degradedReason ?? 'No ephemeral environment for this run.' }}
    </p>
  </section>
</template>
