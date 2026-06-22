<script setup lang="ts">
import { computed, ref } from 'vue'

// Local-mode setup prompt: when the local facade boots without a GitHub PAT, every
// repo-operating agent step (clone, push, open PR, CI gate, merge) will fail. The server
// also logs this, but a dev terminal is easy to miss — so surface it in the UI with the
// (scopes-preselected) creation URL as a one-click link straight to GitHub.
const auth = useAuthStore()

const setupUrl = computed(() => auth.localMode?.githubPatSetupUrl ?? '')
const dismissed = ref(false)
const show = computed(() => !!setupUrl.value && !dismissed.value)
</script>

<template>
  <Transition name="fade">
    <div v-if="show" class="absolute inset-x-0 top-0 z-50 flex justify-center px-4 pt-4">
      <div
        class="w-full max-w-3xl rounded-2xl border-2 border-amber-500/70 bg-amber-950/95 p-5 shadow-2xl backdrop-blur"
        role="alert"
      >
        <div class="flex items-start gap-4">
          <UIcon name="i-lucide-key-round" class="mt-0.5 h-9 w-9 shrink-0 text-amber-400" />
          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-3">
              <h2 class="text-lg font-semibold text-amber-100">
                GitHub PAT not configured
              </h2>
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                icon="i-lucide-x"
                aria-label="Dismiss"
                @click="dismissed = true"
              />
            </div>
            <p class="mt-1 text-sm text-amber-200/90">
              Local mode reaches GitHub with a personal access token. Without one, agent steps
              that clone, push, open PRs, gate on CI or merge will fail.
            </p>

            <div class="mt-4">
              <UButton
                :to="setupUrl"
                target="_blank"
                rel="noopener noreferrer"
                color="warning"
                variant="solid"
                icon="i-lucide-external-link"
                trailing
              >
                Create a GitHub token (scopes pre-selected)
              </UButton>
              <p class="mt-2 text-xs text-amber-300/70">
                Then set <code class="font-mono">GITHUB_PAT</code> and restart.
              </p>
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
