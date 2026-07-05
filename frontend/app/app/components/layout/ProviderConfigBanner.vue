<script setup lang="ts">
// Loud prompt that an infrastructure provider is wired for this instance but the workspace
// hasn't supplied its mandatory config yet — mirroring AiProvidersBanner. A custom
// environment provider / runner pool can declare required-without-default fields (e.g. an
// API token); until they're set, the provider can't run, so we surface it with a direct
// link into its connect panel. Dismissible per session.
import { computed, ref, watch } from 'vue'
import type { ProviderConnectionKind } from '~/types/providerConnections'

const { t } = useI18n()
const ui = useUiStore()
const workspace = useWorkspaceStore()
const store = useProviderConnectionsStore()

// Exhaustive per-kind title/action keys (leaf names mirror the kind verbatim).
const TITLE_KEYS: Record<ProviderConnectionKind, string> = {
  environment: 'layout.providerConfigBanner.titleOne.environment',
  'runner-pool': 'layout.providerConfigBanner.titleOne.runner-pool',
}
const ACTION_KEYS: Record<ProviderConnectionKind, string> = {
  environment: 'layout.providerConfigBanner.action.environment',
  'runner-pool': 'layout.providerConfigBanner.action.runner-pool',
}

// Probe both providers once the workspace is ready (the descriptor view is secret-less).
watch(
  () => workspace.ready,
  (ready) => {
    if (ready) void store.ensureLoaded().catch(() => {})
  },
  { immediate: true },
)

const dismissed = ref(false)
const pending = computed(() => store.needingConfig as ProviderConnectionKind[])
const show = computed(() => pending.value.length > 0 && !dismissed.value)
</script>

<template>
  <Transition name="fade">
    <!-- Positioning/stacking is owned by the shared banner column in `pages/index.vue`; this
         renders only its card and re-enables pointer events on it. -->
    <div v-if="show" class="pointer-events-auto w-full max-w-3xl">
      <div
        class="w-full max-w-3xl rounded-2xl border-2 border-amber-500/70 bg-amber-950/95 p-5 shadow-2xl backdrop-blur"
        role="alert"
      >
        <div class="flex items-start gap-4">
          <UIcon name="i-lucide-plug" class="mt-0.5 h-9 w-9 shrink-0 text-amber-400" />
          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-3">
              <h2 class="text-lg font-semibold text-amber-100">
                {{
                  pending.length > 1
                    ? t('layout.providerConfigBanner.titleMany')
                    : t(TITLE_KEYS[pending[0]!])
                }}
              </h2>
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                icon="i-lucide-x"
                :aria-label="t('common.close')"
                @click="
                  () => {
                    dismissed = true
                  }
                "
              />
            </div>
            <p class="mt-1 text-sm text-amber-200/90">
              {{ t('layout.providerConfigBanner.body') }}
            </p>
            <div class="mt-4 flex flex-wrap gap-2">
              <UButton
                v-for="k in pending"
                :key="k"
                color="warning"
                variant="solid"
                icon="i-lucide-settings"
                @click="ui.openProviderConnection(k)"
              >
                {{ t(ACTION_KEYS[k]) }}
              </UButton>
            </div>
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
