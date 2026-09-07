<script setup lang="ts">
import { computed } from 'vue'
import type {
  EnvironmentProbeFailure,
  EnvironmentProbeReport,
  EnvironmentProbeVerdict,
} from '@cat-factory/contracts'

// What the AGENT DRY RUN found, as the inspector renders it.
//
// The order is deliberate and is the order a developer acts in: the VERDICT (can an agent work
// here at all), then what the platform failed to tell the agent (the thing to go and fix), then
// the operations as evidence, then the agent's own prose last. `missingContext` sits above the
// operation list rather than below it because it is the product of the diagnostic: an operator who
// reads only the first two lines has read the actionable part.
const props = defineProps<{ report: EnvironmentProbeReport }>()

const { t, te } = useI18n()

/**
 * Per-verdict label keys, exhaustive over the contracts union: a new verdict fails THIS
 * typecheck until it has copy. (The lookup is dynamic, so the typed-message-keys check cannot see
 * it; the map's exhaustiveness is the drift guard, as with the stage keys.)
 */
const VERDICT_KEYS: Record<EnvironmentProbeVerdict, string> = {
  operable: 'inspector.testConfig.envProbe.verdict.operable',
  partially_operable: 'inspector.testConfig.envProbe.verdict.partially_operable',
  inoperable: 'inspector.testConfig.envProbe.verdict.inoperable',
}

const VERDICT_CLASS: Record<EnvironmentProbeVerdict, string> = {
  operable: 'text-emerald-300/90',
  // Amber, not rose: the LIFECYCLE succeeded and the finding is partial. Colouring it as a
  // failure would make it read as the run breaking rather than as the diagnostic working.
  partially_operable: 'text-amber-300/90',
  inoperable: 'text-rose-300/90',
}

/**
 * Per-failure-kind labels, exhaustive over the contracts vocabulary. Rendered through a `te`
 * guard: the kinds are a CLOSED and PERSISTED vocabulary, so a report stored before a member was
 * renamed must still render honestly (the raw value) rather than as an empty span.
 */
const FAILURE_KEYS: Record<EnvironmentProbeFailure, string> = {
  auth_missing: 'inspector.testConfig.envProbe.failure.auth_missing',
  auth_rejected: 'inspector.testConfig.envProbe.failure.auth_rejected',
  access_unclear: 'inspector.testConfig.envProbe.failure.access_unclear',
  endpoint_unknown: 'inspector.testConfig.envProbe.failure.endpoint_unknown',
  unreachable: 'inspector.testConfig.envProbe.failure.unreachable',
  timeout: 'inspector.testConfig.envProbe.failure.timeout',
  server_error: 'inspector.testConfig.envProbe.failure.server_error',
  bad_request: 'inspector.testConfig.envProbe.failure.bad_request',
  tooling_missing: 'inspector.testConfig.envProbe.failure.tooling_missing',
  other: 'inspector.testConfig.envProbe.failure.other',
}

function failureLabel(kind: EnvironmentProbeFailure): string {
  const key = FAILURE_KEYS[kind]
  return key && te(key) ? t(key) : kind
}

const verdictLabel = computed(() => {
  const key = VERDICT_KEYS[props.report.verdict]
  return key && te(key) ? t(key) : props.report.verdict
})

const verdictClass = computed(() => VERDICT_CLASS[props.report.verdict] ?? 'text-slate-300')

/** The icon per operation outcome. `not_attempted` is its own mark, never a failure's. */
function outcomeIcon(outcome: EnvironmentProbeReport['operations'][number]['outcome']): string {
  if (outcome === 'succeeded') return 'i-lucide-check'
  if (outcome === 'failed') return 'i-lucide-x'
  return 'i-lucide-minus'
}

function outcomeClass(outcome: EnvironmentProbeReport['operations'][number]['outcome']): string {
  if (outcome === 'succeeded') return 'text-emerald-400'
  if (outcome === 'failed') return 'text-rose-400'
  return 'text-slate-500'
}
</script>

<template>
  <div
    class="space-y-2 rounded border border-white/5 bg-white/[0.02] p-2"
    data-testid="env-probe-report"
  >
    <p class="text-[11px] font-medium" :class="verdictClass" data-testid="env-probe-verdict">
      {{ verdictLabel }}
    </p>

    <!-- The tallies the PLATFORM computed from the agent's per-operation judgements, including
         how many successes were behind authentication: the count the verdict turns on. -->
    <p class="text-[11px] text-slate-400">
      {{
        t('inspector.testConfig.envProbe.counts', {
          succeeded: report.succeeded,
          attempted: report.attempted,
          authenticated: report.authenticatedSucceeded,
        })
      }}
    </p>

    <!-- What the platform did not tell the agent: the actionable half of the report, so it comes
         before the evidence. -->
    <div v-if="report.missingContext.length" data-testid="env-probe-missing">
      <p class="text-[11px] font-medium text-amber-300/90">
        {{ t('inspector.testConfig.envProbe.missingContext') }}
      </p>
      <ul class="mt-0.5 list-disc space-y-0.5 pl-4 text-[11px] text-slate-300">
        <li v-for="(line, i) in report.missingContext" :key="i">{{ line }}</li>
      </ul>
    </div>

    <div v-if="report.blockers.length" data-testid="env-probe-blockers">
      <p class="text-[11px] font-medium text-rose-300/90">
        {{ t('inspector.testConfig.envProbe.blockers') }}
      </p>
      <ul class="mt-0.5 space-y-0.5 text-[11px] text-slate-300">
        <li v-for="(blocker, i) in report.blockers" :key="i">
          <span class="text-slate-400">{{ failureLabel(blocker.kind) }}:</span>
          {{ blocker.detail }}
        </li>
      </ul>
    </div>

    <!-- The operations, as evidence for the verdict above. This is the "what was attempted" a dry
         run exists to report: without it a verdict is an opinion. -->
    <div v-if="report.operations.length" data-testid="env-probe-operations">
      <p class="text-[11px] font-medium text-slate-300">
        {{ t('inspector.testConfig.envProbe.operations') }}
      </p>
      <ul class="mt-0.5 space-y-1 text-[11px]">
        <li v-for="(op, i) in report.operations" :key="i" class="flex items-start gap-1.5">
          <UIcon
            :name="outcomeIcon(op.outcome)"
            class="mt-0.5 size-3 shrink-0"
            :class="outcomeClass(op.outcome)"
          />
          <span class="min-w-0">
            <span class="text-slate-200">{{ op.name }}</span>
            <span v-if="op.authenticated" class="ml-1 text-slate-500">
              {{ t('inspector.testConfig.envProbe.authenticated') }}
            </span>
            <span v-if="op.target" class="ml-1 font-mono text-slate-500">{{ op.target }}</span>
            <span v-if="op.failure" class="block text-rose-300/70">
              {{ failureLabel(op.failure) }}<template v-if="op.detail">: {{ op.detail }}</template>
            </span>
            <span v-else-if="op.detail" class="block text-slate-400">{{ op.detail }}</span>
          </span>
        </li>
      </ul>
      <!-- Every cap records what it dropped: a reader must never take a truncated list for the
           whole attempt. -->
      <p v-if="report.operationsOmitted" class="mt-1 text-[11px] text-slate-500">
        {{
          t('inspector.testConfig.envProbe.operationsOmitted', { count: report.operationsOmitted })
        }}
      </p>
    </div>

    <p v-if="report.summary" class="text-[11px] text-slate-400">{{ report.summary }}</p>
    <p v-if="report.model" class="text-[11px] text-slate-600">
      {{ t('inspector.testConfig.envProbe.model', { model: report.model }) }}
    </p>
  </div>
</template>
