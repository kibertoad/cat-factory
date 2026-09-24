<script setup lang="ts">
import { computed } from 'vue'
import {
  delegatedUsageUnreported,
  delegationStatusView,
  externalRunHref,
} from './StepDelegatedStatus.logic'
import type { PipelineStep } from '~/types/execution'

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
// missing number is invisible. See `delegatedUsageUnreported`, which answers a settled step from
// contracts' own rule, the one the backend's gap fold reads, so the card and the debug overview
// cannot disagree about one step.
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

/**
 * Everything the card renders for this record's status, narrowed against the vocabulary this build
 * ships. See `StepDelegatedStatus.logic` for why a bare `Record` lookup cannot be used here.
 */
const statusView = computed(() => delegationStatusView(record.value?.status))

/** The executor's own label when this build registers it, else the persisted id. */
const executorName = computed(() => props.executor?.label || record.value?.executor || '')

/**
 * The branch the work LANDED on, shown only when there is no pull request to show instead.
 *
 * An executor that pushes and lets a later step open the PR is a case the port names as
 * legitimate, and then this is the run's entire product: without it the card reports a completed
 * external run with nothing to point at.
 */
const landedBranch = computed(() => record.value?.branch ?? null)

/**
 * The run link, only when it is one this SPA may follow. The value comes from an external
 * system's API, and this is the card's primary affordance; see {@link externalRunHref}.
 */
const runHref = computed(() => externalRunHref(record.value?.url))

/** Whether to say the platform is not measuring this step's spend; see the logic sibling. */
const usageUnreported = computed(() => delegatedUsageUnreported(props.step, props.executor))

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
    <div class="rounded-lg border px-3 py-2 text-xs" :class="statusView.meta.cls">
      <div class="flex items-center gap-2">
        <UIcon
          :name="statusView.meta.icon"
          class="h-4 w-4 shrink-0"
          :class="statusView.meta.spin ? 'animate-spin' : ''"
        />
        <!-- A status this build does not know is NAMED as unrecognised, carrying the stored value,
             rather than guessed onto a current one or silently dropped. -->
        <span class="font-medium">{{ t(statusView.labelKey, statusView.labelParams) }}</span>
        <span class="text-dimmed">·</span>
        <span class="truncate" :title="executor?.description">{{ executorName }}</span>
        <template v-if="record.phase && statusView.status === 'running'">
          <span class="text-dimmed">·</span>
          <span>{{ record.phase }}</span>
        </template>
      </div>

      <!-- The PRIMARY affordance: the executor's own logs. It is the only place the detail of
           what happened exists, which is why a failed delegated step without it is a dead end. -->
      <div v-if="record.url" class="mt-2 flex items-center gap-2">
        <dt class="shrink-0 text-2xs uppercase tracking-wide text-dimmed">
          {{ t('panels.stepMeta.delegated.run') }}
        </dt>
        <!-- Linked only when the executor's URL is `http(s)`. Anything else is shown as the text
             it is: refusing to follow it is right, and hiding it would report a run that named
             no link at all. -->
        <dd class="truncate font-mono text-2xs text-toned">
          <a
            v-if="runHref"
            :href="runHref"
            target="_blank"
            rel="noopener noreferrer"
            class="hover:underline"
          >
            {{ record.url }}
          </a>
          <span v-else>{{ record.url }}</span>
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

      <!-- The branch the work landed on, for an executor that pushed without opening a pull
           request. Rendered here because the platform holds nothing else about that run's
           product. -->
      <div v-if="landedBranch" class="mt-2 flex items-center gap-2">
        <dt class="shrink-0 text-2xs uppercase tracking-wide text-dimmed">
          {{ t('panels.stepMeta.delegated.branch') }}
        </dt>
        <dd class="truncate font-mono text-2xs text-toned">{{ landedBranch }}</dd>
      </div>

      <!-- What the platform could not do, stated rather than left to read as a clean outcome:
           a cancelled run whose executor declares no cancel is still going. -->
      <p v-if="record.note" class="mt-2 text-2xs text-toned">{{ record.note }}</p>
    </div>

    <!-- "Absent" and "zero" must never render the same. Without this line a delegated step shows
         no tokens beside a container step that shows some, and the only available reading is that
         it was free. -->
    <p v-if="usageUnreported" class="mt-2 text-2xs text-dimmed">
      {{ t('panels.stepMeta.delegated.usageNotReported', { executor: executorName }) }}
    </p>

    <!-- Earlier attempts. Kept across a re-run on purpose: the previous run's logs are the
         evidence for why this step is being run again, and the platform holds nothing else. -->
    <div v-if="priorAttempts.length" class="mt-3">
      <div class="text-2xs uppercase tracking-wide text-dimmed">
        {{ t('panels.stepMeta.delegated.earlierAttempts') }}
      </div>
      <ul class="mt-1 space-y-1">
        <li
          v-for="(attempt, index) in priorAttempts"
          :key="`${attempt.startedAt}-${index}`"
          class="flex items-center gap-2 text-2xs text-muted"
        >
          <span class="truncate">{{
            attempt.outcome || t('panels.stepMeta.delegated.noOutcome')
          }}</span>
          <a
            v-if="externalRunHref(attempt.url)"
            :href="externalRunHref(attempt.url)!"
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
