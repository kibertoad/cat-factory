<script setup lang="ts">
import { computed } from 'vue'
import type { InputGateIssue, InputGateIssueCode, RunInputGate } from '@cat-factory/contracts'
import type { InputGateTone } from '~/utils/inputGate'
import { useInputGateStore } from '~/stores/inputGate'

// The PRE-DISPATCH INPUT GATE's notice: what the structural check found in the task's authored
// input, and the two ways out. Shown wherever a run parked on the gate is surfaced (the
// inspector's execution panel, the step-detail overlay), so it is a plain component over a
// verdict rather than an overlay of its own, its remedy is to go and edit the task, which is a
// board action a modal would be in the way of.
//
// Every line of copy is keyed off the finding CODE, never off backend prose: the backend does
// not localize, and its `describeInputGateIssues` summary is a detail line for logs.

const props = defineProps<{
  /** The run's verdict. Which verdicts earn a notice is `inputGateNoticeFor`'s decision. */
  gate: RunInputGate
  /**
   * How to present it (see {@link InputGateTone}). Passed in rather than re-derived from
   * `gate.status`, because the advisory tone is NOT a status: it is a `passed` verdict that
   * happens to carry findings, and a component deriving its own tone would have to repeat that
   * rule and would go on rendering advisories as if the run had been cleared with nothing found.
   */
  tone: InputGateTone
  /** The run this verdict belongs to, for the resolve calls. */
  executionId: string
  /** Compact form drops the explanatory paragraph (used inside the step-detail rail). */
  compact?: boolean
}>()

const { t, te } = useI18n()
const inputGate = useInputGateStore()

/**
 * Finding code → its translated copy, as an EXHAUSTIVE `Record` of LITERAL keys. Two guards in
 * one: the Record fails to compile when a code is added without copy, and the literal keys are
 * what the typed-message-key check can see (an assembled `\`inputGate.issue.${code}.title\`` is
 * invisible to it). The `te` fallback below covers the case neither can, a run PERSISTED under
 * a code this build has since retired.
 */
const ISSUE_KEYS = {
  description_missing: {
    title: 'inputGate.issue.description_missing.title',
    hint: 'inputGate.issue.description_missing.hint',
  },
  description_placeholder: {
    title: 'inputGate.issue.description_placeholder.title',
    hint: 'inputGate.issue.description_placeholder.hint',
  },
  description_thin: {
    title: 'inputGate.issue.description_thin.title',
    hint: 'inputGate.issue.description_thin.hint',
  },
  reproduction_missing: {
    title: 'inputGate.issue.reproduction_missing.title',
    hint: 'inputGate.issue.reproduction_missing.hint',
  },
  review_target_missing: {
    title: 'inputGate.issue.review_target_missing.title',
    hint: 'inputGate.issue.review_target_missing.hint',
  },
  success_criteria_missing: {
    title: 'inputGate.issue.success_criteria_missing.title',
    hint: 'inputGate.issue.success_criteria_missing.hint',
  },
  required_field_missing: {
    title: 'inputGate.issue.required_field_missing.title',
    hint: 'inputGate.issue.required_field_missing.hint',
  },
} as const satisfies Record<InputGateIssueCode, { title: string; hint: string }>

/**
 * The findings, blocking first. Sorting here rather than trusting the emitted order keeps the
 * thing a human must fix at the top even when an advisory was found earlier in the check.
 */
const issues = computed<InputGateIssue[]>(() =>
  [...props.gate.issues].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === 'blocking' ? -1 : 1,
  ),
)

/** Only a parked verdict has anything to answer; the other two tones are a record. */
const blocking = computed(() => props.tone === 'blocked')

/** Title + body keys per tone, as literals so the typed-message-key check can see them. */
const TONE_COPY: Record<InputGateTone, { title: string; body: string }> = {
  blocked: { title: 'inputGate.blockedTitle', body: 'inputGate.blockedBody' },
  waived: { title: 'inputGate.waivedTitle', body: 'inputGate.waivedBody' },
  advisory: { title: 'inputGate.advisoryTitle', body: 'inputGate.advisoryBody' },
}
const copy = computed(() => TONE_COPY[props.tone])

/**
 * The interpolation a finding's copy is rendered with. Only `required_field_missing` carries a
 * `field`, and its copy is the one line that cannot be written without knowing which input is
 * missing: a deployment registers its own task types, so the platform has no vocabulary for
 * "the incident's severity" and names the field instead. The label is deployment-supplied
 * English, exactly as a custom agent kind's is.
 *
 * A finding whose `field` is somehow absent still renders: the copy falls back to naming no
 * field rather than printing `undefined` into a sentence a human is meant to act on.
 */
function issueValues(issue: InputGateIssue): Record<string, string> {
  return { field: issue.field?.label ?? t('inputGate.issue.required_field_missing.unnamedField') }
}

/** A finding's translated title, falling back to the generic line for a retired code. */
function issueTitle(issue: InputGateIssue): string {
  const key = ISSUE_KEYS[issue.code]?.title
  return key && te(key) ? t(key, issueValues(issue)) : t('inputGate.issue.unknown.title')
}

/** A finding's translated remedy hint, on the same fallback. */
function issueHint(issue: InputGateIssue): string {
  const key = ISSUE_KEYS[issue.code]?.hint
  return key && te(key) ? t(key, issueValues(issue)) : t('inputGate.issue.unknown.hint')
}

async function resolve(choice: 'recheck' | 'proceed') {
  await inputGate.resolve(props.executionId, choice)
}
</script>

<template>
  <div
    class="rounded-lg border p-3"
    :class="
      blocking
        ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40'
        : 'border-default bg-elevated/40'
    "
    :data-tone="tone"
    data-testid="input-gate-notice"
  >
    <div class="flex items-start gap-2">
      <UIcon
        :name="blocking ? 'i-lucide-file-question' : 'i-lucide-info'"
        class="mt-0.5 size-4 shrink-0"
        :class="blocking ? 'text-amber-600 dark:text-amber-400' : 'text-muted'"
      />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">{{ t(copy.title) }}</p>
        <p v-if="!compact" class="text-muted mt-0.5 text-xs">{{ t(copy.body) }}</p>

        <ul class="mt-2 space-y-1.5">
          <li
            v-for="issue in issues"
            :key="`${issue.code}:${issue.field?.key ?? ''}`"
            class="flex items-start gap-2 text-xs"
          >
            <UBadge
              :color="issue.severity === 'blocking' ? 'warning' : 'neutral'"
              variant="subtle"
              size="sm"
            >
              {{
                issue.severity === 'blocking'
                  ? t('inputGate.severity.blocking')
                  : t('inputGate.severity.advisory')
              }}
            </UBadge>
            <span class="min-w-0">
              <span class="font-medium">{{ issueTitle(issue) }}</span>
              <span class="text-muted">, {{ issueHint(issue) }}</span>
            </span>
          </li>
        </ul>

        <div v-if="blocking" class="mt-3 flex flex-wrap items-center gap-2">
          <UButton
            color="primary"
            size="xs"
            icon="i-lucide-refresh-cw"
            :loading="inputGate.resolving"
            data-testid="input-gate-recheck"
            @click="resolve('recheck')"
          >
            {{ t('inputGate.recheck') }}
          </UButton>
          <UButton
            color="neutral"
            variant="ghost"
            size="xs"
            :disabled="inputGate.resolving"
            data-testid="input-gate-proceed"
            @click="resolve('proceed')"
          >
            {{ t('inputGate.proceed') }}
          </UButton>
          <span class="text-muted text-xs">{{ t('inputGate.recheckHint') }}</span>
        </div>

        <p v-if="inputGate.error" class="text-error mt-2 text-xs">{{ inputGate.error }}</p>
      </div>
    </div>
  </div>
</template>
