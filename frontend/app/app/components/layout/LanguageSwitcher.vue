<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import { computed } from 'vue'
import { useLocaleStore } from '~/stores/locale'

// Language picker for the SPA's supported locales, shown at the sidebar bottom next to
// the user menu. The list is data-driven from the i18n config (`useI18n().locales`), so
// adding a locale in nuxt.config.ts surfaces it here automatically. Selecting one switches
// the live locale AND persists the choice (the locale store) so it survives a reload.
const { t, locale, locales, setLocale } = useI18n()
const localeStore = useLocaleStore()

const current = computed(
  () => locales.value.find((l) => l.code === locale.value)?.name ?? locale.value,
)

// The typed-messages guard narrows the locale to the configured union, so take the same
// type setLocale expects rather than a bare string.
async function choose(code: typeof locale.value) {
  if (code === locale.value) return
  await setLocale(code)
  localeStore.set(code)
}

const items = computed<DropdownMenuItem[][]>(() => [
  locales.value.map((l) => ({
    label: l.name ?? l.code,
    icon: l.code === locale.value ? 'i-lucide-check' : undefined,
    onSelect: () => {
      void choose(l.code)
    },
  })),
])
</script>

<template>
  <UDropdownMenu :items="items" :content="{ side: 'top', align: 'start' }">
    <button
      type="button"
      data-testid="language-switcher"
      :aria-label="t('language.switcher')"
      class="flex w-full items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 p-2 text-start transition hover:bg-slate-800/60"
    >
      <UIcon name="i-lucide-languages" class="h-4 w-4 shrink-0 text-slate-400" />
      <div class="min-w-0 flex-1">
        <div class="truncate text-[10px] uppercase tracking-wide text-slate-500">
          {{ t('language.switcher') }}
        </div>
        <div class="truncate text-xs font-medium text-white">{{ current }}</div>
      </div>
      <UIcon name="i-lucide-chevron-up" class="h-4 w-4 shrink-0 text-slate-500" />
    </button>
  </UDropdownMenu>
</template>
