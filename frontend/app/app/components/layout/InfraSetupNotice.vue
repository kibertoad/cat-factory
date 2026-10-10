<script setup lang="ts">
// The one line a caller sees for a setup gap they cannot fix from where they are, when it stops
// their runs. It replaces the full card (and its "Configure" button that would open a screen their
// save is refused on) with two facts: what does not work, and how it gets fixed. Compact on
// purpose: the caller has nothing to do here, so it must not cover the board the way an actionable
// card may.
import type { DropdownMenuItem } from '@nuxt/ui'
import type { BlockingInfraArea, SetupNotice, SetupRemedy } from '~/utils/setupAudience'

defineProps<{
  notice: SetupNotice
  /** The card's own session / permanent choice, built by the banner so both close the same claim. */
  dismissMenu: DropdownMenuItem[][]
}>()

const { t } = useI18n()

// Exhaustive over the blocking areas and the remedies, so a new member of either fails typecheck
// here rather than rendering a raw key.
const STATE_KEYS: Record<BlockingInfraArea, Record<SetupNotice['kind'], string>> = {
  agentExecutor: {
    setup: 'layout.infraSetupNotice.agentExecutor.setup',
    outage: 'layout.infraSetupNotice.agentExecutor.outage',
  },
}
const REMEDY_KEYS: Record<SetupRemedy, string> = {
  workspace_admin: 'layout.infraSetupNotice.owner.workspace_admin',
  account_admin: 'layout.infraSetupNotice.owner.account_admin',
  operator: 'layout.infraSetupNotice.owner.operator',
  full_surface: 'layout.infraSetupNotice.fullSurface',
}
</script>

<template>
  <div
    class="pointer-events-auto flex w-full max-w-3xl items-center gap-3 rounded-xl border px-4 py-2 shadow-lg backdrop-blur"
    :class="
      notice.kind === 'outage'
        ? 'border-app-error-500/50 bg-app-error-950/90'
        : 'border-app-warning-500/50 bg-app-warning-950/90'
    "
    :data-testid="`infra-setup-notice-${notice.area}`"
    :data-infra-remedy="notice.remedy"
  >
    <UIcon
      :name="notice.kind === 'outage' ? 'i-lucide-plug-zap' : 'i-lucide-server-off'"
      class="h-5 w-5 shrink-0"
      :class="notice.kind === 'outage' ? 'text-app-error-400' : 'text-app-warning-400'"
    />
    <p
      class="min-w-0 flex-1 text-sm"
      :class="notice.kind === 'outage' ? 'text-app-error-100' : 'text-app-warning-100'"
    >
      {{ t(STATE_KEYS[notice.area][notice.kind]) }}
      <span class="opacity-80">{{ t(REMEDY_KEYS[notice.remedy]) }}</span>
    </p>
    <UDropdownMenu :items="dismissMenu" :content="{ align: 'end' }">
      <UButton
        color="neutral"
        variant="ghost"
        size="xs"
        icon="i-lucide-x"
        class="shrink-0"
        :aria-label="t('common.close')"
        :data-testid="`infra-setup-notice-dismiss-${notice.area}`"
      />
    </UDropdownMenu>
  </div>
</template>
