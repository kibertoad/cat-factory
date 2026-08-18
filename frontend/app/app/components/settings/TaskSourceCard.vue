<script setup lang="ts">
// One connected-source row of the issue-tracker settings panel: what the source is, whether the
// workspace can use it, the live setup check, and the on/off toggle.
//
// It renders from the source's own STATE (the descriptor the backend registry serves plus the
// workspace's live availability), so a source is a row here the moment its provider is
// registered. That is the whole reason this component exists: the panel used to hold one
// hard-coded card per built-in, which meant a newly shipped source had no setup check and no
// toggle until someone remembered to paste a fourth copy, and a deployment-registered source
// never got one at all.
//
// The single thing that still varies per source is the REMEDY for an unavailable one, and it
// varies along an axis the state names: `ridesVcsProvider` says the source authenticates through
// the workspace's VCS connection (so the fix lives on the VCS integration surface, and the copy
// names that provider), while a null one carries its own credentials (so the fix is this
// source's own connect form). Both are emitted as one `remedy` event; where it navigates is the
// panel's business.
import { computed } from 'vue'
import type { TaskSourceDiagnosticStatus, TaskSourceState } from '~/types/domain'
import { VCS_PROVIDER_LABELS } from '~/utils/vcs'

const props = defineProps<{
  state: TaskSourceState
  /** The last live setup-check verdict for this source, if one has been run. */
  diagnostic?: {
    status: TaskSourceDiagnosticStatus
    message: string
    detail?: string | null
  } | null
  /** A setup check is in flight for this source. */
  checking?: boolean
  /** The enable/disable toggle is in flight for this source. */
  toggling?: boolean
}>()

const emit = defineEmits<{
  check: []
  toggle: [enabled: boolean]
  remedy: []
}>()

const { t } = useI18n()

/** The brand name of the VCS connection this source rides, or null when it carries credentials. */
const vcsLabel = computed(() =>
  props.state.ridesVcsProvider ? VCS_PROVIDER_LABELS[props.state.ridesVcsProvider] : null,
)

/**
 * The one-line explanation under the source name: what makes it usable, or what is missing.
 * Four cases rather than two, because "rides a connection you already have" and "connected with
 * its own credentials" are different facts, and so are the two ways of fixing an unavailable one.
 */
const subtitle = computed(() => {
  const provider = vcsLabel.value
  if (provider) {
    return props.state.available
      ? t('settings.issueTracker.linking.state.ridesConnected', { provider })
      : t('settings.issueTracker.linking.state.ridesMissing', { provider })
  }
  return props.state.available
    ? t('settings.issueTracker.linking.connected')
    : t('settings.issueTracker.linking.state.notConnected')
})

/** The label of the button that leads to whatever is missing. */
const remedyLabel = computed(() =>
  vcsLabel.value
    ? t('settings.issueTracker.linking.connectProvider', { provider: vcsLabel.value })
    : t('settings.issueTracker.linking.connect'),
)

// Status → presentation for a setup-check verdict. Exhaustive over the status vocabulary, so a
// new verdict fails the typecheck here rather than rendering with no icon.
const STATUS_UI: Record<
  TaskSourceDiagnosticStatus,
  { color: 'success' | 'warning' | 'error' | 'neutral'; icon: string }
> = {
  ready: { color: 'success', icon: 'i-lucide-circle-check' },
  not_installed: { color: 'warning', icon: 'i-lucide-download' },
  not_connected: { color: 'warning', icon: 'i-lucide-plug' },
  auth_failed: { color: 'error', icon: 'i-lucide-key-round' },
  forbidden: { color: 'error', icon: 'i-lucide-shield-x' },
  unreachable: { color: 'error', icon: 'i-lucide-wifi-off' },
  // Warning rather than error: nothing about the connection is broken, and the fix is to wait.
  rate_limited: { color: 'warning', icon: 'i-lucide-hourglass' },
  error: { color: 'error', icon: 'i-lucide-triangle-alert' },
}
</script>

<template>
  <div class="rounded-lg border border-slate-800 bg-slate-800/40 px-3 py-2.5">
    <div class="flex items-center justify-between gap-2">
      <div class="flex min-w-0 items-center gap-2.5">
        <UIcon :name="state.icon" class="h-5 w-5 shrink-0 text-slate-300" />
        <div class="min-w-0">
          <div class="text-sm font-medium text-slate-200">{{ state.label }}</div>
          <div class="text-[11px] text-slate-500">{{ subtitle }}</div>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <!-- Offered whatever the state: the check is precisely the "why is this not working"
             affordance, and its verdict distinguishes a missing connection from a broken one. -->
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-stethoscope"
          :loading="checking"
          :data-testid="`task-source-check-${state.source}`"
          @click="emit('check')"
        >
          {{ t('settings.issueTracker.linking.checkSetup') }}
        </UButton>
        <USwitch
          v-if="state.available"
          :model-value="state.enabled"
          :loading="toggling"
          :data-testid="`task-source-toggle-${state.source}`"
          @update:model-value="(v: boolean) => emit('toggle', v)"
        />
        <UButton
          v-else
          size="xs"
          color="neutral"
          variant="soft"
          :icon="state.icon"
          :data-testid="`task-source-remedy-${state.source}`"
          @click="emit('remedy')"
        >
          {{ remedyLabel }}
        </UButton>
      </div>
    </div>
    <UAlert
      v-if="diagnostic"
      class="mt-2.5"
      :color="STATUS_UI[diagnostic.status].color"
      variant="subtle"
      :icon="STATUS_UI[diagnostic.status].icon"
      :description="diagnostic.message + (diagnostic.detail ? ` ${diagnostic.detail}` : '')"
      :ui="{ description: 'text-[11px]' }"
    />
  </div>
</template>
