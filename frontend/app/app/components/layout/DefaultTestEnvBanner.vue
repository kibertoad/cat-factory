<script setup lang="ts">
// Convenience prompt to pick the board's DEFAULT test-environment provisioning mechanism — the
// provision type suggested for every newly added service. Fires on a workspace that has recorded
// no choice, which covers all three cases the product asked for with ONE condition rather than
// three: a board created by hand, the board the SPA creates implicitly on first launch, and an
// older board that predates the setting. All of them simply have `defaultProvisionType == null`.
//
// The nag ends the moment a decision is RECORDED, including `infraless` ("services stand up no
// environment") — that is a real answer, not an absence. See the contracts block comment on
// `defaultProvisionType` for why the field is nullable rather than defaulted.
//
// Positioning/stacking against the sibling advisory banners is owned by the shared click-through
// column in `pages/index.vue`; this renders only its card and re-enables pointer events on it.
import { computed } from 'vue'
import {
  defaultProvisioningConfigUrl,
  needsDefaultProvisioningChoice,
} from '~/utils/defaultProvisioning'

const { t } = useI18n()
const ui = useUiStore()
const workspace = useWorkspaceStore()
const settingsStore = useWorkspaceSettingsStore()
const { canManageSettings } = useWorkspaceAccess()

// Only prompt someone who can actually answer. A member/viewer cannot write workspace settings
// (the endpoint is `settings.manage`-gated), so for them this would be an un-actionable nag
// pointing at a screen that would refuse their save.
const show = computed(
  () =>
    workspace.ready &&
    canManageSettings.value &&
    needsDefaultProvisioningChoice(settingsStore.settings) &&
    !ui.defaultProvisionDismissed,
)

// A real, copyable link to the configuration screen — so this can be handed to whoever owns the
// board's infrastructure instead of being described. Clicking it opens the screen in place
// (no reload); the `href` is what makes middle-click, "copy link address" and open-in-new-tab
// work, and the ui store consumes the same param on load so a pasted link lands on the section.
const configUrl = computed(() => defaultProvisioningConfigUrl())

function openConfig(event: MouseEvent) {
  // Leave the modified clicks (new tab / new window / download) to the browser.
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
  event.preventDefault()
  ui.openDefaultProvisionSettings()
}
</script>

<template>
  <Transition name="fade">
    <div
      v-if="show"
      class="pointer-events-auto w-full max-w-3xl rounded-2xl border border-sky-500/50 bg-sky-950/90 p-4 shadow-xl backdrop-blur"
      role="status"
      aria-live="polite"
      data-testid="default-test-env-banner"
    >
      <div class="flex items-start gap-3">
        <UIcon name="i-lucide-flask-conical" class="mt-0.5 h-7 w-7 shrink-0 text-sky-400" />
        <div class="min-w-0 flex-1">
          <div class="flex items-start justify-between gap-3">
            <h2 class="text-sm font-semibold text-sky-100">
              {{ t('layout.defaultTestEnvBanner.title') }}
            </h2>
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-x"
              :aria-label="t('common.close')"
              data-testid="default-test-env-dismiss"
              @click="ui.dismissDefaultProvision()"
            />
          </div>
          <p class="mt-1 text-[13px] text-sky-200/90">
            {{ t('layout.defaultTestEnvBanner.body') }}
          </p>
          <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <UButton
              :to="configUrl"
              size="sm"
              color="info"
              variant="solid"
              icon="i-lucide-settings"
              data-testid="default-test-env-configure"
              @click="openConfig"
            >
              {{ t('layout.defaultTestEnvBanner.action') }}
            </UButton>
            <!-- The URL itself, shown so it can be read and copied, not just clicked. -->
            <a
              :href="configUrl"
              class="min-w-0 truncate font-mono text-[11px] text-sky-300/80 underline decoration-dotted underline-offset-2 hover:text-sky-200"
              data-testid="default-test-env-url"
              @click="openConfig"
            >
              {{ configUrl }}
            </a>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
