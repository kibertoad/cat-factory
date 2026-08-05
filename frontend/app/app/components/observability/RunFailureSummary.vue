<script setup lang="ts">
import { computed } from 'vue'
import type { RunFailureEvidence } from '~/utils/observability'
import { noFailingCallReason } from '~/utils/observability'
import { agentKindMeta } from '~/utils/catalog'
import { FAILURE_KIND_KEYS } from '~/utils/failureKinds'
import FailureDetail from '~/components/board/FailureDetail.vue'

// The panel's FIRST section: what broke, pinned above the call list instead of found by
// scrolling it.
//
// Three things are shown together because each answers a question the others cannot:
//
//  - the run's own structured failure record (`agent_runs.failure`), which names the class of
//    death and where to look, but never which call;
//  - the last MODEL call that failed, the transport / proxy / spend-gate side;
//  - the last TOOL call that failed, the side no rollup counts — a tool that errors inside the
//    container leaves the model call that requested it reporting `ok` with a clean finish
//    reason, so every LLM number on this panel reads healthy right up to the moment the run dies.
//
// The two evidence rows are shown in a FIXED order and are not ranked against each other. They
// come from different clocks (a call's recorded `createdAt`, a tool span's harness-stamped
// `startedAt`), so "which happened last" is not a comparison this can make honestly, and a
// confident wrong ordering here is worse than none: the whole section exists to be believed.
//
// Every count it prints is a run-level SQL aggregate rather than the length of a list the panel
// happens to hold, and any bound it renders under says so. Counting off the loaded rows would be
// the same mistake one layer up as filtering a bounded prefix in JS, and it fails the same way:
// silently, on exactly the long runs worth opening this panel for.
const props = defineProps<{ evidence: RunFailureEvidence }>()
const emit = defineEmits<{
  /** Open the model call with this id in the call list. */
  showCall: [callId: string]
  /** Open the tool-call trajectory, narrowed to the failures. */
  showFailingTools: []
  /** Re-request whichever telemetry read failed. */
  retry: []
}>()

const { t, d } = useI18n()

/** Why no failing call could be pinned, or null when one was. See `noFailingCallReason`. */
const emptyReason = computed(() => noFailingCallReason(props.evidence))

function clock(ms: number): string {
  return d(new Date(ms), 'long')
}
function agentMeta(kind: string) {
  return agentKindMeta(kind)
}

/**
 * The failure's kind as translated copy.
 *
 * Through the shared `FAILURE_KIND_KEYS` map, never the raw enum: `job_failed` and
 * `companion_rejected` are storage spellings, and the map is an exhaustive
 * `Record<AgentFailureKind, …>` so a kind added to the contract fails the typecheck here instead
 * of surfacing as a code in the middle of a sentence.
 */
const failureKindLabel = computed(() => {
  const failure = props.evidence.failure
  return failure ? t(FAILURE_KIND_KEYS[failure.kind]) : ''
})

/**
 * A tool call's result text, or null when there is nothing honest to show.
 *
 * `withheld` is NOT an empty result: the bodies were never captured (the deployment switch or
 * the workspace opt-out), so rendering `''` would present the failing call as a tool that said
 * nothing about why it failed. The template says which of the two it is.
 */
const failedToolResult = computed(() => {
  const call = props.evidence.lastFailedToolCall
  if (!call || call.bodies !== 'stored') return null
  return call.result || null
})

/** How many failing tool calls precede the pinned one, or null when it is the only one. */
const earlierFailedToolCalls = computed(() =>
  props.evidence.failedToolCallCount > 1 ? props.evidence.failedToolCallCount - 1 : null,
)
</script>

<template>
  <section class="rounded-xl border border-rose-900/60 bg-rose-950/20 p-4">
    <div class="flex items-start gap-3">
      <UIcon name="i-lucide-siren" class="mt-0.5 h-5 w-5 shrink-0 text-rose-400" />
      <div class="min-w-0 flex-1">
        <h2 class="text-[13px] font-semibold text-rose-200">
          {{ t('observability.failure.title') }}
        </h2>

        <!-- The run's own structured record. Absent on a run that is still going, or that
             failed without one; the evidence below stands on its own either way. -->
        <template v-if="evidence.failure">
          <p class="mt-1 text-[13px] text-slate-200">{{ evidence.failure.message }}</p>
          <div class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
            <span>{{ t('observability.failure.kind', { kind: failureKindLabel }) }}</span>
            <span v-if="evidence.failure.stepIndex != null">
              {{ t('observability.failure.atStep', { index: evidence.failure.stepIndex + 1 }) }}
            </span>
            <span>{{ clock(evidence.failure.occurredAt) }}</span>
          </div>
          <!-- The shared disclosure the failure banner and the prior-errors history use:
               collapsed, copyable, and silent when the detail merely repeats the message. A
               pinned triage header is the last place an unbounded stack trace should sit
               expanded by default, pushing the failing call it exists to surface off-screen. -->
          <FailureDetail
            :detail="evidence.failure.detail"
            :message="evidence.failure.message"
            summary-class="text-[11px] text-slate-500 hover:text-slate-300"
            pre-class="bg-slate-950/60 text-[11px] text-slate-400"
          />
          <p v-if="evidence.failure.hint" class="mt-1.5 text-[12px] text-slate-300">
            {{ evidence.failure.hint }}
          </p>
        </template>
      </div>
    </div>

    <!-- The failing calls themselves. -->
    <div class="mt-3 space-y-2">
      <!-- Last model call that FAILED outright. -->
      <button
        v-if="evidence.lastErroredCall"
        type="button"
        class="flex w-full items-start gap-3 rounded-lg border border-rose-900/50 bg-slate-950/50 px-3 py-2 text-start transition hover:bg-slate-900/70"
        @click="emit('showCall', evidence.lastErroredCall.id)"
      >
        <UIcon
          :name="agentMeta(evidence.lastErroredCall.agentKind).icon"
          class="mt-0.5 h-4 w-4 shrink-0"
          :style="{ color: agentMeta(evidence.lastErroredCall.agentKind).color }"
        />
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-baseline gap-x-2 text-[12px]">
            <span class="font-medium text-slate-200">
              {{ t('observability.failure.lastErroredCall') }}
            </span>
            <span class="text-slate-500">
              {{ agentMeta(evidence.lastErroredCall.agentKind).label }} ·
              {{ evidence.lastErroredCall.provider }}:{{ evidence.lastErroredCall.model }}
            </span>
            <UBadge color="error" variant="subtle" size="sm">
              {{ evidence.lastErroredCall.httpStatus ?? t('observability.call.error') }}
            </UBadge>
          </div>
          <p v-if="evidence.lastErroredCall.errorMessage" class="mt-0.5 text-[12px] text-rose-300">
            {{ evidence.lastErroredCall.errorMessage }}
          </p>
          <p v-if="evidence.erroredCallCount > 1" class="mt-0.5 text-[11px] text-slate-500">
            {{
              t(
                'observability.failure.moreErroredCalls',
                { count: evidence.erroredCallCount - 1 },
                evidence.erroredCallCount - 1,
              )
            }}
          </p>
        </div>
        <UIcon name="i-lucide-chevron-right" class="mt-0.5 h-4 w-4 shrink-0 text-slate-600" />
      </button>

      <!-- Last TOOL call that failed: the row no rollup counts. -->
      <button
        v-if="evidence.lastFailedToolCall"
        type="button"
        class="flex w-full items-start gap-3 rounded-lg border border-rose-900/50 bg-slate-950/50 px-3 py-2 text-start transition hover:bg-slate-900/70"
        @click="emit('showFailingTools')"
      >
        <UIcon name="i-lucide-wrench" class="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-baseline gap-x-2 text-[12px]">
            <span class="font-medium text-slate-200">
              <!-- "One of the failing calls" when even the failures were bounded: the row is
                   real either way, but calling it the LAST would be a claim about rows this
                   read never saw. -->
              {{
                evidence.failedToolCallsTruncated
                  ? t('observability.failure.aFailedToolCall')
                  : t('observability.failure.lastFailedToolCall')
              }}
            </span>
            <span class="font-mono text-slate-300">{{ evidence.lastFailedToolCall.tool }}</span>
            <span class="text-slate-500">
              {{ agentMeta(evidence.lastFailedToolCall.agentKind).label }}
            </span>
          </div>
          <pre
            v-if="failedToolResult"
            class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-rose-300"
            >{{ failedToolResult }}</pre>
          <p v-else class="mt-0.5 text-[11px] italic text-slate-500">
            {{
              evidence.lastFailedToolCall.bodies === 'stored'
                ? t('observability.failure.toolReturnedNothing')
                : t('observability.failure.toolBodiesWithheld')
            }}
          </p>
          <p v-if="earlierFailedToolCalls" class="mt-0.5 text-[11px] text-slate-500">
            {{
              t(
                'observability.failure.moreFailedToolCalls',
                { count: earlierFailedToolCalls },
                earlierFailedToolCalls,
              )
            }}
          </p>
        </div>
        <UIcon name="i-lucide-chevron-right" class="mt-0.5 h-4 w-4 shrink-0 text-slate-600" />
      </button>

      <!-- Nothing failing to point at. Which of the reasons it is decides what an operator should
           do next, so each gets its own sentence rather than one shared shrug. `emptyReason` is
           null whenever EITHER sink held a failure, so it already covers the model-call arm
           above, and null while a sink is still loading, which is what stops a read that has not
           come back from being reported as one that came back clean. -->
      <div
        v-else-if="emptyReason"
        class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed px-3 py-2 text-[12px]"
        :class="
          emptyReason === 'sink-unreachable'
            ? 'border-amber-900/60 text-amber-300'
            : 'border-slate-800 text-slate-400'
        "
      >
        <span>{{ t(`observability.failure.noFailingCall.${emptyReason}`) }}</span>
        <!-- The one empty state with an action attached: the others are answers, this one is the
             absence of one. -->
        <UButton
          v-if="emptyReason === 'sink-unreachable'"
          icon="i-lucide-rotate-cw"
          color="neutral"
          variant="soft"
          size="xs"
          @click="emit('retry')"
        >
          {{ t('common.retry') }}
        </UButton>
      </div>
    </div>
  </section>
</template>
