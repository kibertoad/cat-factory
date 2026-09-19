<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import { computed } from 'vue'
import { useThemeStore } from '~/stores/theme'

// Appearance picker, shown at the sidebar bottom beside the language switcher: colour MODE
// (system / light / dark) and THEME (the built-ins) in one dropdown, because they are two halves of one question ("what does the
// app look like") and each on its own would cost a footer row for a control used once.
//
// Mode is `@nuxtjs/color-mode`'s preference (its own persisted storage); theme is the theme store.
// Neither is a deployment setting or an RBAC matter, so the row shows for every tier and role.
//
// `collapsed` renders the icon-only rail variant; the dropdown itself is unchanged.
withDefaults(defineProps<{ collapsed?: boolean }>(), { collapsed: false })

const { t } = useI18n()
const colorMode = useColorMode()
const theme = useThemeStore()

type ModePreference = 'system' | 'light' | 'dark'
const MODES: readonly ModePreference[] = ['system', 'light', 'dark']
// Static literal keys, one per mode, so the typed-message-keys check sees them.
const MODE_LABELS: Record<ModePreference, string> = {
  system: 'appearance.mode.system',
  light: 'appearance.mode.light',
  dark: 'appearance.mode.dark',
}
const MODE_ICONS: Record<ModePreference, string> = {
  system: 'i-lucide-monitor',
  light: 'i-lucide-sun',
  dark: 'i-lucide-moon',
}

function isMode(value: string): value is ModePreference {
  return (MODES as readonly string[]).includes(value)
}
const preference = computed<ModePreference>(() =>
  isMode(colorMode.preference) ? colorMode.preference : 'system',
)

const summary = computed(() => `${theme.active.name} · ${t(MODE_LABELS[preference.value])}`)

const items = computed<DropdownMenuItem[][]>(() => [
  MODES.map((mode) => ({
    label: t(MODE_LABELS[mode]),
    icon: MODE_ICONS[mode],
    type: 'checkbox' as const,
    checked: preference.value === mode,
    onSelect: () => {
      colorMode.preference = mode
    },
  })),
  [
    { label: t('appearance.theme.section'), type: 'label' as const },
    ...theme.themes.map((candidate) => ({
      label: candidate.name,
      type: 'checkbox' as const,
      checked: theme.current === candidate.id,
      onSelect: () => theme.select(candidate.id),
    })),
  ],
])
</script>

<template>
  <UDropdownMenu :items="items" :content="{ side: 'top', align: 'start' }">
    <button
      type="button"
      data-testid="appearance-switcher"
      :aria-label="t('appearance.switcher')"
      :title="collapsed ? `${t('appearance.switcher')}: ${summary}` : undefined"
      class="flex w-full items-center gap-2 rounded-lg border border-default bg-default/60 p-2 text-start transition hover:bg-elevated/60"
      :class="collapsed ? 'justify-center' : ''"
    >
      <UIcon :name="MODE_ICONS[preference]" class="h-4 w-4 shrink-0 text-muted" />
      <div v-if="!collapsed" class="min-w-0 flex-1">
        <div class="truncate text-[10px] uppercase tracking-wide text-dimmed">
          {{ t('appearance.switcher') }}
        </div>
        <div class="truncate text-xs font-medium text-highlighted">{{ summary }}</div>
      </div>
      <UIcon v-if="!collapsed" name="i-lucide-chevron-up" class="h-4 w-4 shrink-0 text-dimmed" />
    </button>
  </UDropdownMenu>
</template>
