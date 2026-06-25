<script setup lang="ts">
// Persistent prompt that AI isn't ready, mirroring GitHubPatBanner. Two states, in priority
// order: (1) no usable model source at all → "Configure AI" reopens the onboarding dialog;
// (2) usable models exist but the default model preset points at unavailable ones → a milder
// warning reopening the preset-mismatch dialog. Dismissible per session (the dismissed flags
// live on the ui store, so the auto-open watcher and this banner share one source of truth).
import { computed } from 'vue'

const ui = useUiStore()
const { ready, hasUsableModel, defaultPresetBroken } = useAiReadiness()

const showSetup = computed(() => ready.value && !hasUsableModel.value && !ui.aiSetupDismissed)
const showPreset = computed(() => ready.value && defaultPresetBroken.value && !ui.aiPresetDismissed)
// The no-AI prompt owns the screen when nothing works; the preset prompt is secondary.
const show = computed(() => showSetup.value || showPreset.value)
</script>

<template>
  <Transition name="fade">
    <div v-if="show" class="absolute inset-x-0 top-0 z-40 flex justify-center px-4 pt-4">
      <!-- (1) No usable AI source -->
      <div
        v-if="showSetup"
        class="w-full max-w-3xl rounded-2xl border-2 border-amber-500/70 bg-amber-950/95 p-5 shadow-2xl backdrop-blur"
        role="alert"
      >
        <div class="flex items-start gap-4">
          <UIcon name="i-lucide-cpu" class="mt-0.5 h-9 w-9 shrink-0 text-amber-400" />
          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-3">
              <h2 class="text-lg font-semibold text-amber-100">No AI model configured</h2>
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                icon="i-lucide-x"
                aria-label="Dismiss"
                @click="ui.dismissAiSetup()"
              />
            </div>
            <p class="mt-1 text-sm text-amber-200/90">
              Agents need a model to run. AI works out of the box only on a Cloudflare deployment
              with Workers AI enabled — otherwise connect a provider key, subscription, proxy, or
              local runner to continue.
            </p>
            <div class="mt-4">
              <UButton
                color="warning"
                variant="solid"
                icon="i-lucide-settings"
                @click="ui.openAiProviderSetup()"
              >
                Configure AI
              </UButton>
            </div>
          </div>
        </div>
      </div>

      <!-- (2) Default preset references unavailable models -->
      <div
        v-else
        class="w-full max-w-3xl rounded-2xl border border-amber-500/50 bg-amber-950/90 p-4 shadow-xl backdrop-blur"
        role="alert"
      >
        <div class="flex items-start gap-3">
          <UIcon name="i-lucide-triangle-alert" class="mt-0.5 h-7 w-7 shrink-0 text-amber-400" />
          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-3">
              <h2 class="text-sm font-semibold text-amber-100">
                Default model preset uses unavailable models
              </h2>
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                icon="i-lucide-x"
                aria-label="Dismiss"
                @click="ui.dismissAiPresetMismatch()"
              />
            </div>
            <p class="mt-1 text-[13px] text-amber-200/90">
              Tasks using the default preset would fail. Edit the preset or configure the missing
              provider.
            </p>
            <div class="mt-3">
              <UButton
                size="sm"
                color="warning"
                variant="solid"
                icon="i-lucide-cpu"
                @click="ui.openAiPresetMismatch()"
              >
                Review preset
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
