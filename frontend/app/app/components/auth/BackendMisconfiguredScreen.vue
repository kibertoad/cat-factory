<script setup lang="ts">
import type { ConfigProblem } from '@cat-factory/contracts'

// Shown when the backend booted into its misconfiguration fallback: it couldn't start normally
// because one or more mandatory environment variables / bindings are missing or invalid. We list
// each one with what it is for and how to fill it, so the developer can fix their env and reload
// rather than staring at a generic "can't reach the backend" panel. The `problems` never carry a
// secret value — only the variable name, its meaning, and the remedy.
const auth = useAuthStore()
const { t } = useI18n()

const problems = computed<ConfigProblem[]>(() => auth.misconfigured?.problems ?? [])

function reload() {
  window.location.reload()
}
</script>

<template>
  <div
    class="flex h-screen w-screen flex-col items-center justify-center bg-app-950 p-6 text-default"
  >
    <div class="w-full max-w-2xl">
      <div class="mb-6 text-center">
        <UIcon name="i-lucide-server-cog" class="mx-auto mb-3 h-10 w-10 text-app-warning-400" />
        <h1 class="text-lg font-semibold">{{ t('app.misconfigured.title') }}</h1>
        <p class="mx-auto mt-2 max-w-lg text-sm text-muted">
          {{ t('app.misconfigured.intro') }}
        </p>
      </div>

      <ul class="space-y-3">
        <li
          v-for="problem in problems"
          :key="problem.key"
          class="rounded-lg border border-default bg-default/60 p-4"
        >
          <code class="text-sm font-semibold text-app-warning-300">{{ problem.key }}</code>
          <p class="mt-1 text-sm text-toned">{{ problem.summary }}</p>
          <p class="mt-2 text-sm text-muted">
            <span class="font-medium text-toned">{{ t('app.misconfigured.howToFix') }}</span>
            {{ problem.remedy }}
          </p>
          <a
            v-if="problem.docsUrl"
            :href="problem.docsUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="mt-2 inline-flex items-center gap-1 text-sm text-app-warning-300 hover:text-app-warning-200"
          >
            <UIcon name="i-lucide-book-open" class="h-4 w-4" />
            {{ t('app.misconfigured.viewDocs') }}
          </a>
        </li>
      </ul>

      <div class="mt-6 flex items-center justify-center gap-3">
        <UButton color="primary" icon="i-lucide-rotate-ccw" @click="reload">
          {{ t('app.misconfigured.reload') }}
        </UButton>
      </div>
      <p class="mt-4 text-center text-xs text-dimmed">{{ t('app.misconfigured.hint') }}</p>
    </div>
  </div>
</template>
