<script setup lang="ts">
import { useLocalStorage } from '@vueuse/core'
import { computed } from 'vue'

// Shown whenever the active locale is NOT English: the non-English catalogs are
// community/AI-provided and may be inaccurate, so warn the user and point them at the
// repository to report mistakes or open a fix PR. Rendered as a slim full-width strip at
// the very top (distinct from the centered config-warning cards below it, so they don't
// overlap). Dismissal is persisted per-locale in localStorage: once dismissed for a locale
// it stays hidden across reloads, but switching to a different (separately-translated)
// locale shows it again, since that catalog is a fresh, independently-translated context.
const REPO_URL = 'https://github.com/kibertoad/cat-factory'

const { t, locale } = useI18n()

const dismissedLocales = useLocalStorage<string[]>('cat-factory:translation-warning-dismissed', [])
const show = computed(() => locale.value !== 'en' && !dismissedLocales.value.includes(locale.value))

function dismiss() {
  if (!dismissedLocales.value.includes(locale.value)) {
    dismissedLocales.value = [...dismissedLocales.value, locale.value]
  }
}
</script>

<template>
  <Transition name="fade">
    <div
      v-if="show"
      data-testid="translation-warning"
      role="alert"
      class="fixed inset-x-0 top-0 z-50 flex items-center gap-3 border-b border-amber-500/40 bg-amber-950/95 px-4 py-2 text-[13px] text-amber-100 shadow-lg backdrop-blur"
    >
      <UIcon name="i-lucide-languages" class="h-4 w-4 shrink-0 text-amber-400" />
      <p class="min-w-0 flex-1">
        <span class="font-semibold">{{ t('language.warning.title') }}</span>
        <span class="mx-1.5 text-amber-400/60">·</span>
        <i18n-t keypath="language.warning.body" tag="span" scope="global">
          <template #repoLink>
            <a
              :href="REPO_URL"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1 font-medium text-sky-300 hover:underline"
            >
              {{ t('language.warning.repoLinkLabel') }}
              <UIcon name="i-lucide-external-link" class="h-3 w-3" />
            </a>
          </template>
        </i18n-t>
      </p>
      <UButton
        color="neutral"
        variant="ghost"
        size="xs"
        icon="i-lucide-x"
        :aria-label="t('language.warning.dismiss')"
        @click="dismiss"
      />
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
