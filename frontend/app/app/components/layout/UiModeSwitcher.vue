<script setup lang="ts">
import { computed } from 'vue'
import { UI_MODES, type UiMode } from '~/utils/uiMode'

// Interface-tier picker, shown at the TOP of the sidebar under the board switcher. Basic mode
// hides the power-user destinations and the less-used run options; advanced shows everything.
//
// It is a SEGMENTED control rather than a dropdown, and it sits above the fold rather than in the
// footer, because basic is the shipped default and this row is most users' only sight of the tier:
// a dropdown states the current mode but not that another one exists, so the half of the product
// it gates is discoverable only to someone who already opens menus to see what is in them. Showing
// both segments makes the choice — and the fact that there IS a choice — legible at rest.
//
// The user's pick is persisted client-side — unless the deployment pinned the tier via
// NUXT_PUBLIC_UI_MODE, in which case the row is a read-only indicator, since writing a preference
// the resolver ignores would be a lie (see `stores/uiMode.ts`).
//
// `collapsed` is the icon-only rail (basic mode's own default), where two segments do not fit at
// 3.5rem. It degrades to ONE button that flips the tier directly — with only two modes a toggle is
// unambiguous — keeping the current tier's NAME under the glyph rather than an icon alone.
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
/** The tier the rail button would switch TO, so its tooltip names the act and not the state. */
const otherMode = computed<UiMode>(() => (uiMode.isAdvanced ? 'basic' : 'advanced'))
/** Tooltip for the pinned row (both variants): mode + why it can't be changed. */
const pinnedTitle = computed(
  () => `${t('uiMode.switcher')}: ${currentLabel.value} (${t('uiMode.pinned')})`,
)
</script>

<template>
  <!-- Pinned by the deployment: no control, just the current tier. -->
  <div
    v-if="uiMode.envPinned"
    data-testid="ui-mode-pinned"
    :title="pinnedTitle"
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

  <!-- Rail: one button, flips the tier. The label rides under the glyph so the rail still says
       which tier is on — the audience that needs to find the advanced half is exactly the one
       sitting in basic mode's collapsed default. -->
  <button
    v-else-if="collapsed"
    type="button"
    data-testid="ui-mode-toggle"
    :aria-label="t('uiMode.switchTo', { mode: t(MODE_LABELS[otherMode]) })"
    :title="t('uiMode.switchTo', { mode: t(MODE_LABELS[otherMode]) })"
    class="flex w-full flex-col items-center gap-0.5 rounded-lg border border-slate-700 bg-slate-900/60 px-1 py-1.5 transition hover:border-indigo-500/60 hover:bg-slate-800/60"
    @click="uiMode.toggleMode()"
  >
    <UIcon :name="icon" class="h-4 w-4 shrink-0 text-indigo-400" />
    <span class="w-full truncate text-center text-[9px] font-medium uppercase text-slate-300">
      {{ currentLabel }}
    </span>
  </button>

  <div v-else data-testid="ui-mode-switcher" class="w-full">
    <div class="mb-1 px-1 text-[10px] uppercase tracking-wide text-slate-500">
      {{ t('uiMode.switcher') }}
    </div>
    <div
      role="group"
      :aria-label="t('uiMode.switcher')"
      class="flex w-full gap-1 rounded-lg border border-slate-700 bg-slate-900/60 p-1"
    >
      <button
        v-for="mode in UI_MODES"
        :key="mode"
        type="button"
        :data-testid="`ui-mode-option-${mode}`"
        :aria-pressed="mode === uiMode.mode"
        class="flex-1 truncate rounded-md px-2 py-1 text-xs font-medium transition"
        :class="
          mode === uiMode.mode
            ? 'bg-indigo-500/20 text-indigo-200 ring-1 ring-indigo-500/50'
            : 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-200'
        "
        @click="uiMode.setMode(mode)"
      >
        {{ t(MODE_LABELS[mode]) }}
      </button>
    </div>
  </div>

  <!-- The one-line "what this tier gives you", so the choice is self-explanatory. Dropped in
       the collapsed rail, where the tooltip above carries the mode instead. -->
  <p v-if="!collapsed" class="px-1 text-[10px] leading-snug text-slate-500">
    {{ t(MODE_HINTS[uiMode.mode]) }}
  </p>
</template>
