<script setup lang="ts">
// The verdict of one "Test connection" probe, rendered identically everywhere a connect form
// offers that button.
//
// Its own component because the message stopped being a few words. A failed probe now reports
// the EXACT transport failure plus what to do about it (kernel's `connectionFailureResult`),
// which runs to a sentence or three, and the inline `<span>` each form used to carry sat inside
// a `flex items-center` row beside the button, where a long message squashes the button and
// overflows the panel. So the result is a block that wraps, and the six forms share it rather
// than each growing its own copy of the same markup.
//
// Two lines, because that account is English by construction and this SPA ships in ten languages.
// The backend states the failure CLASS as a machine-readable `failureCause`; the headline is that
// class in the operator's own language, and the backend's prose sits under it as the detail. The
// detail stays VISIBLE rather than folding behind a disclosure: it is the half that names the
// concrete host, port and remedy, and a probe verdict is read to find out what to go fix.
import { computed } from 'vue'
import type { ConnectionFailureCause } from '@cat-factory/contracts'
import { CONNECTION_FAILURE_CAUSE_KEYS } from '~/utils/connectionFailures'

const props = defineProps<{
  /** The probe verdict; null before the first test (renders nothing). */
  result: { ok: boolean; message?: string; failureCause?: ConnectionFailureCause } | null
}>()

const { t, te } = useI18n()

/**
 * The translated-headline key for this failure, or null when there is none: an `unknown` cause, a
 * cause this SPA build predates, or a failure that was an ANSWER (an HTTP status the provider
 * mapped itself, which carries no transport cause). In every one of those the backend's own
 * message becomes the primary line, so a missing translation is never a blank verdict.
 */
const causeKey = computed(() => {
  const cause = props.result && !props.result.ok ? props.result.failureCause : undefined
  const key = cause ? CONNECTION_FAILURE_CAUSE_KEYS[cause] : null
  return key && te(key) ? key : null
})

const headline = computed(() =>
  causeKey.value
    ? t(causeKey.value)
    : (props.result?.message ?? t('settings.providerConnection.test.failed')),
)

/** The backend's English account, shown only when a headline took the primary line from it. */
const detail = computed(() => (causeKey.value ? (props.result?.message ?? '') : ''))
</script>

<template>
  <p
    v-if="result?.ok"
    class="text-xs text-emerald-400 break-words"
    data-testid="connection-test-result"
  >
    {{ result.message ?? t('settings.providerConnection.test.ok') }}
  </p>
  <div v-else-if="result" class="space-y-0.5" data-testid="connection-test-result">
    <p class="text-xs text-rose-400 break-words">{{ headline }}</p>
    <p v-if="detail" class="text-[11px] text-slate-400 break-words">{{ detail }}</p>
  </div>
</template>
