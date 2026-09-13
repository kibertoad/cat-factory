<script setup lang="ts">
import { computed } from 'vue'
import type { PipelineStep, RunDelegationStatus } from '~/types/execution'

// The EXTERNAL work a delegated step dispatched: which registered executor is running it, what it
// is doing, and the link to that system's own logs, which is the affordance everything else here
// exists to frame.
//
// The sibling of `StepContainerStatus`, and deliberately not the same component. A container step
// reports a phase, an id and a reachable address, all of which the platform observes directly; a
// delegated step reports whatever an external system chose to tell us, which is usually a status
// and a URL. Rendering the second through the first would put empty rows labelled "Container" and
// "Address" on every delegated step, and would claim a container the platform never started.
//
// The second thing it says is what the platform CANNOT see. A delegated step's model calls never
// touch this deployment's proxy or recorder, so its tokens are in no total on this page, and a
// missing number is invisible. See `telemetry`.
const props = defineProps<{
  step: PipelineStep
  /**
   * The registered executor's presentation, when this build still registers it. ABSENT is a real
   * state rather than a loading one: a deployment can stop registering an executor while runs that
   * used it are still on the board, and the card then names the id instead of pretending to a
   * label it does not have.
   */
  executor?: { label: string; description: string; telemetry: 'not-reported' | 'self-reported' }
}>()

const { t } = useI18n()

const record = computed(() => props.step.delegated ?? null)

// Static literal keys (not a runtime-built `t(`…${status}`)`) so the typed-message-keys check
// covers them; exhaustive over the union so a new status fails the typecheck here.
const STATUS_KEYS: Record<RunDelegationStatus, string> = {
  starting: 'panels.stepMeta.delegated.status.starting',
  running: 'panels.stepMeta.delegated.status.running',
  done: 'panels.stepMeta.delegated.status.done',
  failed: 'panels.stepMeta.delegated.status.failed',
  cancelled: 'panels.stepMeta.delegated.status.cancelled',
}

const STATUS_META: Record<RunDelegationStatus, { icon: string; spin: boolean; cls: string }> = {
  starting: {
    icon: 'i-lucide-loader-circle',
    spin: true,
    cls: 'border-sky-900/50 bg-sky-950/30 text-sky-300',
  },
  running: {
    icon: 'i-lucide-radio',
    spin: false,
    cls: 'border-indigo-900/50 bg-indigo-950/30 text-indigo-300',
  },
  done: {
    icon: 'i-lucide-circle-check',
    spin: false,
    cls: 'border-emerald-900/50 bg-emerald-950/30 text-emerald-300',
  },
  failed: {
    icon: 'i-lucide-circle-x',
    spin: false,
    cls: 'border-rose-900/50 bg-rose-950/30 text-rose-300',
  },
  cancelled: {
    icon: 'i-lucide-circle-slash',
    spin: false,
    cls: 'border-amber-900/50 bg-amber-950/30 text-amber-300',
  },
}

/** The executor's own label when this build registers it, else the persisted id. */
const executorName = computed(() => props.executor?.label ?? record.value?.executor ?? '')

/**
 * Whether to say the platform is not measuring this step's spend.
 *
 * Shown for an executor that DECLARES it reports nothing, and also for one this build no longer
 * registers (so nothing here can say otherwise). Withheld only where the executor declares it
 * files its own telemetry, because there the ordinary rollup beside this card is the answer.
 */
const usageUnreported = computed(() => props.executor?.telemetry !== 'self-reported')

/** Earlier attempts, newest last, shown only once there is more than the current one. */
const priorAttempts = computed(() => {
  const attempts = record.value?.attempts ?? []
  return attempts.length > 1 ? attempts.slice(0, -1) : []
})

const { copy: copyText } = useCopyToClipboard()
</script>

<template>
  <!-- Single conditional root so a passed-through `class` (e.g. layout margin) applies cleanly.
       Renders nothing for a step that dispatched nowhere external. -->
  <div v-if="record" data-testid="step-delegated-status">
    <div class="rounded-lg border px-3 py-2 text-[12px]" :class="STATUS_META[record.status].cls">
      <div class="flex items-center gap-2">
        <UIcon
          :name="STATUS_META[record.status].icon"
          class="h-4 w-4 shrink-0"
          :class="STATUS_META[record.status].spin ? 'animate-spin' : ''"
        />
        <span class="font-medium">{{ t(STATUS_KEYS[record.status]) }}</span>
        <span class="text-slate-500">·</span>
        <span class="truncate" :title="executor?.description">{{ executorName }}</span>
        <template v-if="record.phase && record.status === 'running'">
          <span class="text-slate-500">·</span>
          <span>{{ record.phase }}</span>
        </template>
      </div>

      <!-- The PRIMARY affordance: the executor's own logs. It is the only place the detail of
           what happened exists, which is why a failed delegated step without it is a dead end. -->
      <div v-if="record.url" class="mt-2 flex items-center gap-2">
        <dt class="shrink-0 text-[11px] uppercase tracking-wide text-slate-500">
          {{ t('panels.stepMeta.delegated.run') }}
        </dt>
        <dd class="truncate font-mono text-[11px] text-slate-300">
          <a :href="record.url" target="_blank" rel="noopener noreferrer" class="hover:underline">
            {{ record.url }}
          </a>
        </dd>
        <UButton
          icon="i-lucide-copy"
          color="neutral"
          variant="ghost"
          size="xs"
          class="ms-auto shrink-0"
          :title="t('panels.stepMeta.delegated.copyUrl')"
          :aria-label="t('panels.stepMeta.delegated.copyUrl')"
          @click="copyText(record.url)"
        />
      </div>

      <!-- What the platform could not do, stated rather than left to read as a clean outcome:
           a cancelled run whose executor declares no cancel is still going. -->
      <p v-if="record.note" class="mt-2 text-[11px] text-slate-300">{{ record.note }}</p>
    </div>

    <!-- "Absent" and "zero" must never render the same. Without this line a delegated step shows
         no tokens beside a container step that shows some, and the only available reading is that
         it was free. -->
    <p v-if="usageUnreported" class="mt-2 text-[11px] text-slate-500">
      {{ t('panels.stepMeta.delegated.usageNotReported', { executor: executorName }) }}
    </p>

    <!-- Earlier attempts. Kept across a re-run on purpose: the previous run's logs are the
         evidence for why this step is being run again, and the platform holds nothing else. -->
    <div v-if="priorAttempts.length" class="mt-3">
      <div class="text-[11px] uppercase tracking-wide text-slate-500">
        {{ t('panels.stepMeta.delegated.earlierAttempts') }}
      </div>
      <ul class="mt-1 space-y-1">
        <li
          v-for="(attempt, index) in priorAttempts"
          :key="`${attempt.startedAt}-${index}`"
          class="flex items-center gap-2 text-[11px] text-slate-400"
        >
          <span class="truncate">{{
            attempt.outcome || t('panels.stepMeta.delegated.noOutcome')
          }}</span>
          <a
            v-if="attempt.url"
            :href="attempt.url"
            target="_blank"
            rel="noopener noreferrer"
            class="ms-auto shrink-0 font-mono hover:underline"
          >
            {{ t('panels.stepMeta.delegated.openRun') }}
          </a>
        </li>
      </ul>
    </div>
  </div>
</template>
