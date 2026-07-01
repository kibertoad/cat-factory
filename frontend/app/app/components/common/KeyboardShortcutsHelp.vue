<script setup lang="ts">
// The keyboard-shortcuts cheatsheet, opened with "?" (or from the command bar). A plain
// UModal listing every global shortcut with its keys rendered as UKbd chips. Driven by the
// ui store so "?" anywhere toggles it.
const { t } = useI18n()
const ui = useUiStore()

const open = computed({
  get: () => ui.shortcutsHelpOpen,
  set: (v: boolean) => (v ? ui.openShortcutsHelp() : ui.closeShortcutsHelp()),
})

// Each row: the display keys + the action label. `mod` renders as ⌘ on Apple, Ctrl elsewhere.
const isApple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '')
const modKey = isApple ? '⌘' : 'Ctrl'

const shortcuts = computed(() => [
  { keys: [modKey, 'K'], label: t('layout.shortcuts.commandBar') },
  { keys: ['Esc'], label: t('layout.shortcuts.deselect') },
  { keys: ['Del'], label: t('layout.shortcuts.deleteBlock') },
  { keys: ['?'], label: t('layout.shortcuts.help') },
])
</script>

<template>
  <UModal v-model:open="open" :title="t('layout.shortcuts.title')" :ui="{ content: 'max-w-md' }">
    <template #body>
      <dl class="space-y-2" data-testid="shortcuts-help">
        <div
          v-for="(s, i) in shortcuts"
          :key="i"
          class="flex items-center justify-between gap-4 rounded-md px-1 py-1.5"
        >
          <dt class="text-sm text-slate-300">{{ s.label }}</dt>
          <dd class="flex shrink-0 items-center gap-1">
            <UKbd v-for="k in s.keys" :key="k" :value="k" />
          </dd>
        </div>
      </dl>
    </template>
  </UModal>
</template>
