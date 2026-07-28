<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import { computed } from 'vue'
import { UI_MODES, type UiMode } from '~/utils/uiMode'

// Interface-tier picker, shown at the sidebar bottom next to the language switcher (the
// same shape, deliberately: both are per-user shell preferences rather than board state).
// Basic mode hides the power-user destinations and the less-used run options; advanced
// shows everything. The user's pick is persisted client-side — unless the deployment pinned
// the tier via NUXT_PUBLIC_UI_MODE, in which case the row is a read-only indicator, since
// writing a preference the resolver ignores would be a lie (see `stores/uiMode.ts`).
withDefaults(defineProps<{ collapsed?: boolean }>(), { collapsed: false })

const uiMode = useUiModeStore()
const { t } = useI18n()

// Static literal `t()` keys, one per UI_MODES member, so the typed-message-keys check sees
// them (a runtime-assembled key wouldn't be checkable).
const MODE_LABELS: Record<UiMode, string> = {
  basic: 'uiMode.basic',
  advanced: 'uiMode.advanced',
}
const MODE_HINTS: Record<UiMode, string> = {
  basic: 'uiMode.basicHint',
  advanced: 'uiMode.advancedHint',
}

const currentLabel = computed(() => t(MODE_LABELS[uiMode.mode]))
const icon = computed(() => (uiMode.isAdvanced ? 'i-lucide-toggle-right' : 'i-lucide-toggle-left'))
/** Tooltip for the collapsed rail (and the pinned row): mode + why it can't be changed. */
const title = computed(() =>
  uiMode.envPinned
    ? `${t('uiMode.switcher')}: ${currentLabel.value} (${t('uiMode.pinned')})`
    : `${t('uiMode.switcher')}: ${currentLabel.value}`,
)

const items = computed<DropdownMenuItem[][]>(() => [
  UI_MODES.map((mode) => ({
    label: t(MODE_LABELS[mode]),
    icon: mode === uiMode.mode ? 'i-lucide-check' : undefined,
    onSelect: () => uiMode.setMode(mode),
  })),
])
</script>

<template>
  <!-- Pinned by the deployment: no dropdown, just the current tier. -->
  <div
    v-if="uiMode.envPinned"
    data-testid="ui-mode-pinned"
    :title="title"
    class="flex w-full items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 p-2 text-start"
    :class="collapsed ? 'justify-center' : ''"
  >
    <UIcon :name="icon" class="h-4 w-4 shrink-0 text-slate-500" />
    <div v-if="!collapsed" class="min-w-0 flex-1">
      <div class="truncate text-[10px] uppercase tracking-wide text-slate-500">
        {{ t('uiMode.switcher') }}
      </div>
      <div class="truncate text-xs font-medium text-slate-300">{{ currentLabel }}</div>
    </div>
    <UIcon v-if="!collapsed" name="i-lucide-lock" class="h-3.5 w-3.5 shrink-0 text-slate-600" />
  </div>

  <UDropdownMenu v-else :items="items" :content="{ side: 'top', align: 'start' }">
    <button
      type="button"
      data-testid="ui-mode-switcher"
      :aria-label="t('uiMode.switcher')"
      :title="title"
      class="flex w-full items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 p-2 text-start transition hover:bg-slate-800/60"
      :class="collapsed ? 'justify-center' : ''"
    >
      <UIcon :name="icon" class="h-4 w-4 shrink-0 text-slate-400" />
      <div v-if="!collapsed" class="min-w-0 flex-1">
        <div class="truncate text-[10px] uppercase tracking-wide text-slate-500">
          {{ t('uiMode.switcher') }}
        </div>
        <div class="truncate text-xs font-medium text-white">{{ currentLabel }}</div>
      </div>
      <UIcon v-if="!collapsed" name="i-lucide-chevron-up" class="h-4 w-4 shrink-0 text-slate-500" />
    </button>
  </UDropdownMenu>

  <!-- The one-line "what this tier gives you", so the choice is self-explanatory. Dropped in
       the collapsed rail, where the tooltip above carries the mode instead. -->
  <p v-if="!collapsed" class="px-1 text-[10px] leading-snug text-slate-500">
    {{ t(MODE_HINTS[uiMode.mode]) }}
  </p>
</template>
