<script setup lang="ts">
import { computed } from 'vue'
import { ROLE_PRESENTATION, UI_ROLES } from '~/utils/uiRole'

// Role picker, at the TOP of the sidebar beside the interface-tier switcher: one place answers
// "how much of the app do I see", and the role is the outer of the two (it can cap the tier, see
// `resolveUiMode`), so it sits above it.
//
// A DROPDOWN rather than the tier switcher's segmented control, and the difference is not
// cosmetic: three role names do not fit legibly across a 15rem sidebar, and the choice has already
// been made explicitly once (the first-run prompt states what each role gives you), so this
// control's job is to NAME the current role and offer the way out, not to advertise that a choice
// exists. It is rendered in EVERY role, including the narrowed one, because it is the way back.
//
// In the collapsed rail it keeps the menu and drops to the glyph plus the role's name, so the rail
// still says which role is on (the same reason the tier button keeps its label there).
withDefaults(defineProps<{ collapsed?: boolean }>(), { collapsed: false })

const uiRole = useUiRoleStore()
const { t } = useI18n()

// Name / glyph / one-line description all come from the shared presentation table, so this
// control and the first-run prompt can never describe the same role differently.
const current = computed(() => ROLE_PRESENTATION[uiRole.role])
const currentLabel = computed(() => t(current.value.labelKey))

const items = computed(() =>
  UI_ROLES.map((role) => ({
    label: t(ROLE_PRESENTATION[role].labelKey),
    icon: ROLE_PRESENTATION[role].icon,
    // The tick, so an open menu says which role is current as well as which are available.
    trailingIcon: role === uiRole.role ? 'i-lucide-check' : undefined,
    onSelect: () => uiRole.setRole(role),
  })),
)
</script>

<template>
  <UDropdownMenu :items="items" :ui="{ content: 'min-w-48' }">
    <!-- Rail: glyph over the role name, matching the tier button beside it. -->
    <button
      v-if="collapsed"
      type="button"
      data-testid="ui-role-toggle"
      :aria-label="`${t('uiRole.switcher')}: ${currentLabel}`"
      :title="`${t('uiRole.switcher')}: ${currentLabel}`"
      class="flex w-full flex-col items-center gap-0.5 rounded-lg border border-slate-700 bg-slate-900/60 px-1 py-1.5 transition hover:border-indigo-500/60 hover:bg-slate-800/60"
    >
      <UIcon :name="current.icon" class="h-4 w-4 shrink-0 text-indigo-400" />
      <span class="w-full truncate text-center text-[9px] font-medium uppercase text-slate-300">
        {{ currentLabel }}
      </span>
    </button>

    <button
      v-else
      type="button"
      data-testid="ui-role-switcher"
      :aria-label="t('uiRole.switcher')"
      :title="t(current.hintKey)"
      class="flex w-full items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/60 p-2 text-start transition hover:border-indigo-500/60 hover:bg-slate-800/60"
    >
      <UIcon :name="current.icon" class="h-4 w-4 shrink-0 text-indigo-400" />
      <div class="min-w-0 flex-1">
        <div class="truncate text-[10px] uppercase tracking-wide text-slate-500">
          {{ t('uiRole.switcher') }}
        </div>
        <div class="truncate text-xs font-medium text-slate-200">{{ currentLabel }}</div>
      </div>
      <UIcon name="i-lucide-chevron-down" class="h-3.5 w-3.5 shrink-0 text-slate-500" />
    </button>
  </UDropdownMenu>
</template>
