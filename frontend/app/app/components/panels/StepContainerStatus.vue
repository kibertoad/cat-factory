<script setup lang="ts">
import { computed } from 'vue'
import type { PipelineStep, RunContainerStatus } from '~/types/execution'

// The per-run container lifecycle for a container-backed step: its status (spinning up /
// running / errored / reclaimed), the live phase (preparing the checkout vs the agent
// making calls), and the container's id + reachable URL once up. Shared by the generic
// step detail (StepMetadataCard) and the dedicated Tester window so both surface WHAT the
// container is doing and WHERE it lives instead of a bare "working" — identical parity.
const props = defineProps<{ step: PipelineStep; runFailed: boolean }>()

const { t, te } = useI18n()

// The container lifecycle to display. The backend persists starting / up / errored; we
// derive `destroyed` once the container is reclaimed — when this step has finished or the
// whole run is no longer running (the per-run container goes as a unit). `errored` wins.
const containerStatus = computed<RunContainerStatus | null>(() => {
  const c = props.step.container
  if (!c) return null
  if (c.status === 'errored') return 'errored'
  if (c.status === 'up' && (props.step.state === 'done' || props.runFailed)) return 'destroyed'
  return c.status
})

// Static literal keys (not a runtime-built `t(`…${status}`)`) so the typed-message-keys
// check covers them; exhaustive over the union so a new status fails the typecheck here.
const CONTAINER_STATUS_KEYS: Record<RunContainerStatus, string> = {
  starting: 'panels.stepMeta.container.status.starting',
  up: 'panels.stepMeta.container.status.up',
  errored: 'panels.stepMeta.container.status.errored',
  destroyed: 'panels.stepMeta.container.status.destroyed',
}
const CONTAINER_STATUS_META: Record<
  RunContainerStatus,
  { icon: string; spin: boolean; cls: string }
> = {
  starting: {
    icon: 'i-lucide-loader-circle',
    spin: true,
    cls: 'border-sky-900/50 bg-sky-950/30 text-sky-300',
  },
  up: {
    icon: 'i-lucide-box',
    spin: false,
    cls: 'border-emerald-900/50 bg-emerald-950/30 text-emerald-300',
  },
  errored: {
    icon: 'i-lucide-circle-x',
    spin: false,
    cls: 'border-rose-900/50 bg-rose-950/30 text-rose-300',
  },
  destroyed: {
    icon: 'i-lucide-power-off',
    spin: false,
    cls: 'border-slate-800 bg-slate-900/40 text-slate-400',
  },
}

// The friendly phase label (clone → "Preparing workspace", agent → "Agent running", …),
// falling back to the raw phase string for an unknown/new phase (the phase vocabulary is
// open-ended). Only meaningful while the container is up.
const phaseLabel = computed(() => {
  const phase = props.step.container?.phase
  if (!phase) return null
  const key = `panels.stepMeta.container.phase.${phase}`
  return te(key) ? t(key) : phase
})

// The legacy boolean cold-boot badge still set by the gate-helper controllers
// (human-test / visual confirmation), shown only when there's no richer `container`.
const showLegacyBadge = computed(
  () => !props.step.container && !!props.step.startingContainer && !props.runFailed,
)
</script>

<template>
  <!-- Single conditional root so a passed-through `class` (e.g. layout margin) applies
       cleanly. Renders nothing for a non-container step / one not yet dispatched. -->
  <div v-if="containerStatus || showLegacyBadge" data-testid="step-container-status">
    <!-- container lifecycle: status (spinning up / running / errored / reclaimed), the
         live phase (preparing the checkout vs the agent making calls), and the
         container's id + reachable URL once up. -->
    <div
      v-if="containerStatus"
      class="rounded-lg border px-3 py-2 text-[12px]"
      :class="CONTAINER_STATUS_META[containerStatus].cls"
    >
      <div class="flex items-center gap-2">
        <UIcon
          :name="CONTAINER_STATUS_META[containerStatus].icon"
          class="h-4 w-4 shrink-0"
          :class="CONTAINER_STATUS_META[containerStatus].spin ? 'animate-spin' : ''"
        />
        <span class="font-medium">{{ t(CONTAINER_STATUS_KEYS[containerStatus]) }}</span>
        <template v-if="phaseLabel && containerStatus === 'up'">
          <span class="text-slate-500">·</span>
          <span>{{ phaseLabel }}</span>
        </template>
      </div>
      <dl v-if="step.container?.id || step.container?.url" class="mt-2 space-y-1">
        <div v-if="step.container?.id" class="flex items-center gap-2">
          <dt class="shrink-0 text-[11px] uppercase tracking-wide text-slate-500">
            {{ t('panels.stepMeta.container.id') }}
          </dt>
          <dd class="truncate font-mono text-[11px] text-slate-300" :title="step.container.id">
            {{ step.container.id }}
          </dd>
        </div>
        <div v-if="step.container?.url" class="flex items-center gap-2">
          <dt class="shrink-0 text-[11px] uppercase tracking-wide text-slate-500">
            {{ t('panels.stepMeta.container.url') }}
          </dt>
          <dd class="truncate font-mono text-[11px] text-slate-300">
            <a
              :href="step.container.url"
              target="_blank"
              rel="noopener noreferrer"
              class="hover:underline"
            >
              {{ step.container.url }}
            </a>
          </dd>
        </div>
      </dl>
    </div>

    <!-- legacy cold-boot badge for gate-helper steps that still set only the flag. -->
    <div
      v-else
      class="flex items-center gap-2 rounded-lg border border-sky-900/50 bg-sky-950/30 px-3 py-2 text-[12px] text-sky-300"
    >
      <UIcon name="i-lucide-loader-circle" class="h-4 w-4 shrink-0 animate-spin" />
      <span>{{ t('panels.stepMeta.spinningUpContainer') }}</span>
    </div>
  </div>
</template>
