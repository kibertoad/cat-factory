<script setup lang="ts">
// Shared collapsible section shell for the inspector panel: a chevron header with an
// optional count, warning flag, and header-actions slot (kept OUTSIDE the toggle button
// so clicking a "+" / menu never collapses the section), plus an optional explanatory
// hint rendered at the top of the body — what the section means and what it is used for.
//
// Open state is a `defineModel` so a parent that needs programmatic control (e.g.
// FrontendConfig opening its Build group after a detect run) can bind `v-model:open`;
// without a binding the model acts as local state and `defaultOpen` picks the initial
// value (controlled callers should drive their own ref instead of passing it).
const props = defineProps<{
  title: string
  icon?: string
  hint?: string
  count?: number
  warning?: boolean
  defaultOpen?: boolean
}>()

const open = defineModel<boolean>('open', { default: false })
if (props.defaultOpen) open.value = true
</script>

<template>
  <section class="border-t border-slate-800 pt-2" data-testid="inspector-section">
    <div class="flex items-center gap-1.5">
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-1.5 text-start text-[11px] font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-200"
        :aria-expanded="open"
        data-testid="inspector-section-toggle"
        @click="open = !open"
      >
        <UIcon
          :name="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
          class="h-3.5 w-3.5 shrink-0 text-slate-500"
        />
        <UIcon v-if="icon" :name="icon" class="h-3.5 w-3.5 shrink-0" />
        <span class="truncate">{{ title }}</span>
        <span v-if="count" class="font-normal normal-case text-slate-500">({{ count }})</span>
        <UIcon
          v-if="warning"
          name="i-lucide-triangle-alert"
          class="h-3.5 w-3.5 shrink-0 text-amber-400"
        />
      </button>
      <slot name="actions" />
    </div>
    <div v-if="open" class="mt-2 space-y-3">
      <p v-if="hint" class="text-[11px] leading-snug text-slate-500">{{ hint }}</p>
      <slot />
    </div>
  </section>
</template>
