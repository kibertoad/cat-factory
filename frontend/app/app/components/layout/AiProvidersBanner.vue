<script setup lang="ts">
// Persistent prompt that AI isn't ready, mirroring GitHubPatBanner. Two states, in priority
// order: (1) no usable model source at all → "Configure AI" reopens the onboarding dialog;
// (2) usable models exist but the default model preset points at unavailable ones → a milder
// warning reopening the preset-mismatch dialog. Dismissible per session (the dismissed flags
// live on the ui store, so the auto-open watcher and this banner share one source of truth).
import { computed } from 'vue'

const { t } = useI18n()
const ui = useUiStore()
const { ready, hasUsableModel, defaultPresetBroken } = useAiReadiness()

const showSetup = computed(() => ready.value && !hasUsableModel.value && !ui.aiSetupDismissed)
const showPreset = computed(() => ready.value && defaultPresetBroken.value && !ui.aiPresetDismissed)
// The no-AI prompt owns the screen when nothing works; the preset prompt is secondary.
const show = computed(() => showSetup.value || showPreset.value)
</script>

<template>
  <Transition name="fade">
    <!-- Positioning/stacking is owned by the shared banner column in `pages/index.vue`; this
         renders only its card and re-enables pointer events on it. -->
    <div v-if="show" class="pointer-events-auto w-full max-w-3xl">
      <!-- (1) No usable AI source -->
      <div
        v-if="showSetup"
        class="w-full max-w-3xl rounded-2xl border-2 border-app-warning-500/70 bg-app-warning-950/95 p-5 shadow-2xl backdrop-blur"
        role="alert"
      >
        <div class="flex items-start gap-4">
          <UIcon name="i-lucide-cpu" class="mt-0.5 h-9 w-9 shrink-0 text-app-warning-400" />
          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-3">
              <h2 class="text-lg font-semibold text-app-warning-100">
                {{ t('layout.aiProvidersBanner.setup.title') }}
              </h2>
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                icon="i-lucide-x"
                :aria-label="t('common.close')"
                @click="ui.dismissAiSetup()"
              />
            </div>
            <p class="mt-1 text-sm text-app-warning-200/90">
              {{ t('layout.aiProvidersBanner.setup.body') }}
            </p>
            <div class="mt-4">
              <UButton
                color="warning"
                variant="solid"
                icon="i-lucide-settings"
                @click="ui.openAiProviderSetup()"
              >
                {{ t('layout.aiProvidersBanner.setup.action') }}
              </UButton>
            </div>
          </div>
        </div>
      </div>

      <!-- (2) Default preset references unavailable models -->
      <div
        v-else
        class="w-full max-w-3xl rounded-2xl border border-app-warning-500/50 bg-app-warning-950/90 p-4 shadow-xl backdrop-blur"
        role="alert"
      >
        <div class="flex items-start gap-3">
          <UIcon
            name="i-lucide-triangle-alert"
            class="mt-0.5 h-7 w-7 shrink-0 text-app-warning-400"
          />
          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-3">
              <h2 class="text-sm font-semibold text-app-warning-100">
                {{ t('layout.aiProvidersBanner.preset.title') }}
              </h2>
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                icon="i-lucide-x"
                :aria-label="t('common.close')"
                @click="ui.dismissAiPresetMismatch()"
              />
            </div>
            <p class="mt-1 text-[13px] text-app-warning-200/90">
              {{ t('layout.aiProvidersBanner.preset.body') }}
            </p>
            <div class="mt-3">
              <UButton
                size="sm"
                color="warning"
                variant="solid"
                icon="i-lucide-cpu"
                @click="ui.openAiPresetMismatch()"
              >
                {{ t('layout.aiProvidersBanner.preset.action') }}
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
