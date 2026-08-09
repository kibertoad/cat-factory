<script setup lang="ts">
// The verdict of one "Test connection" probe, rendered identically everywhere a connect form
// offers that button.
//
// Its own component because the message stopped being a few words. A failed probe now reports
// the EXACT transport failure plus what to do about it (kernel's `connectionFailureMessage`),
// which runs to a sentence or three, and the inline `<span>` each form used to carry sat inside
// a `flex items-center` row beside the button, where a long message squashes the button and
// overflows the panel. So the result is a block that wraps, and the six forms share it rather
// than each growing its own copy of the same markup.
defineProps<{
  /** The probe verdict; null before the first test (renders nothing). */
  result: { ok: boolean; message?: string } | null
}>()

const { t } = useI18n()
</script>

<template>
  <p
    v-if="result?.ok"
    class="text-xs text-emerald-400 break-words"
    data-testid="connection-test-result"
  >
    {{ result.message ?? t('settings.providerConnection.test.ok') }}
  </p>
  <p
    v-else-if="result"
    class="text-xs text-rose-400 break-words"
    data-testid="connection-test-result"
  >
    {{ result.message ?? t('settings.providerConnection.test.failed') }}
  </p>
</template>
