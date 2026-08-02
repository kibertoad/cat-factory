<script setup lang="ts">
// The non-fatal GAPS a connection test reports about the config it just probed: it connects,
// but something it never declared costs a recovery or cleanup path that only shows itself
// during an incident (a runner-pool manifest with no `release` template leaks a runner on
// every cancelled run).
//
// Rendered beside the pass/fail verdict rather than as part of it, because the two are
// independent — a green test with a gap is the common case, and folding the gap into the
// failure line would make a working connection look broken.
//
// The backend sends machine-readable codes (it does not localize prose); the copy lives in the
// catalog behind `CONNECTION_WARNING_KEYS`. A code this SPA build predates falls back to the
// backend's own English `message` — untranslated, but never a blank row.
import type { ConnectionWarning } from '@cat-factory/contracts'
import { CONNECTION_WARNING_KEYS } from '~/utils/connectionWarnings'

const props = defineProps<{
  warnings?: ConnectionWarning[]
  /**
   * Heading for the block. Defaults to the connection-test wording ("gaps in this
   * configuration"), which is wrong for a surface where the finding is about a CREDENTIAL's
   * reach rather than a config gap — those callers pass their own already-translated title.
   */
  title?: string
}>()

const { t, te } = useI18n()

const copy = (warning: ConnectionWarning): string => {
  const key = CONNECTION_WARNING_KEYS[warning.code]
  return key && te(key) ? t(key) : warning.message
}
</script>

<template>
  <div
    v-if="warnings?.length"
    class="rounded-md border border-amber-500/40 bg-amber-950/40 px-3 py-2 text-xs text-amber-200"
    data-testid="connection-warnings"
  >
    <p class="font-semibold">
      {{ props.title ?? t('settings.providerConnection.test.warningsTitle') }}
    </p>
    <ul class="mt-1 list-disc space-y-1 pl-4">
      <li v-for="warning in warnings" :key="warning.code">{{ copy(warning) }}</li>
    </ul>
  </div>
</template>
