<script setup lang="ts">
import { computed } from 'vue'
import type { PipelineStep, RunContainerStatus } from '~/types/execution'
import { containerPhaseLabel } from '~/utils/pipelineRender'

// The per-run container lifecycle for a container-backed step: its status (spinning up /
// running / errored / reclaimed), the live phase (preparing the checkout vs the agent
// making calls), and the container's id + reachable URL once up. Shared by the generic
// step detail (StepMetadataCard) and the dedicated Tester window so both surface WHAT the
// container is doing and WHERE it lives instead of a bare "working" — identical parity.
const props = defineProps<{ step: PipelineStep; runFailed: boolean }>()

const { t, te } = useI18n()

// The container lifecycle to display. The backend persists starting / up / errored; we
// derive `destroyed` once the container is reclaimed — when this step has finished or the
// whole run is no longer running (the per-run container goes as a unit). `errored` wins,
// and a reclaimed container ALWAYS reads "destroyed" — even one caught mid cold-boot
// (`starting`) when the run terminated must NOT linger as a perpetual spinner.
const containerStatus = computed<RunContainerStatus | null>(() => {
  const c = props.step.container
  if (!c) return null
  if (c.status === 'errored') return 'errored'
  if (props.step.state === 'done' || props.runFailed) return 'destroyed'
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

// The friendly phase label (clone → "Preparing workspace", …); only meaningful while up.
const phaseLabel = computed(() => containerPhaseLabel(props.step.container?.phase, { t, te }))

// Make the container id / URL one-click copyable (they're long and used to be
// select-and-copy-by-hand), with a toast confirming the copy landed.
const { copy: copyText } = useCopyToClipboard()
</script>

<template>
  <!-- Single conditional root so a passed-through `class` (e.g. layout margin) applies
       cleanly. Renders nothing for a non-container step / one not yet dispatched. -->
  <div v-if="containerStatus" data-testid="step-container-status">
    <!-- container lifecycle: status (spinning up / running / errored / reclaimed), the
         live phase (preparing the checkout vs the agent making calls), and the
         container's id + reachable URL once up. -->
    <div
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
          <UButton
            icon="i-lucide-copy"
            color="neutral"
            variant="ghost"
            size="xs"
            class="ms-auto shrink-0"
            :title="t('panels.stepMeta.container.copyId')"
            :aria-label="t('panels.stepMeta.container.copyId')"
            @click="copyText(step.container.id)"
          />
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
          <UButton
            icon="i-lucide-copy"
            color="neutral"
            variant="ghost"
            size="xs"
            class="ms-auto shrink-0"
            :title="t('panels.stepMeta.container.copyUrl')"
            :aria-label="t('panels.stepMeta.container.copyUrl')"
            @click="copyText(step.container.url)"
          />
        </div>
      </dl>
    </div>
  </div>
</template>
