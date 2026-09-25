<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import { computed } from 'vue'
import { useLocaleStore } from '~/stores/locale'
import SectionLabel from '~/components/common/SectionLabel.vue'

// Language picker for the SPA's supported locales, shown at the sidebar bottom next to
// the user menu. The list is data-driven from the i18n config (`useI18n().locales`), so
// adding a locale in nuxt.config.ts surfaces it here automatically. Selecting one switches
// the live locale AND persists the choice (the locale store) so it survives a reload.
//
// `collapsed` renders the icon-only rail variant (the sidebar's collapsed state); the
// dropdown itself is unchanged, so the picker stays fully usable from the rail.
withDefaults(defineProps<{ collapsed?: boolean }>(), { collapsed: false })

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
    <UButton
      color="neutral"
      variant="ghost"
      data-testid="language-switcher"
      :aria-label="t('language.switcher')"
      :title="collapsed ? `${t('language.switcher')}: ${current}` : undefined"
      class="flex w-full items-center gap-2 rounded-lg border border-default bg-default/60 p-2 text-start transition hover:bg-elevated/60"
      :class="collapsed ? 'justify-center' : ''"
    >
      <UIcon name="i-lucide-languages" class="h-4 w-4 shrink-0 text-muted" />
      <div v-if="!collapsed" class="min-w-0 flex-1">
        <SectionLabel class="truncate">
          {{ t('language.switcher') }}
        </SectionLabel>
        <div class="truncate text-xs font-medium text-highlighted">{{ current }}</div>
      </div>
      <UIcon v-if="!collapsed" name="i-lucide-chevron-up" class="h-4 w-4 shrink-0 text-dimmed" />
    </UButton>
  </UDropdownMenu>
</template>
