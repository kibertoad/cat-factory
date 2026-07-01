<script setup lang="ts">
// A small, presentational "nothing here yet" placeholder — the reusable version of the
// hand-coded empty renders scattered across the app (context pickers, dependency lists,
// execution history, preset lists). Dumb by design: it takes already-resolved copy and an
// icon, and exposes a default slot for an optional call-to-action button. `compact` shrinks
// it for inline use inside a narrow panel section.
withDefaults(
  defineProps<{
    icon?: string
    title: string
    description?: string
    compact?: boolean
  }>(),
  { icon: 'i-lucide-inbox', compact: false },
)
</script>

<template>
  <div
    class="flex flex-col items-center justify-center text-center text-slate-500"
    :class="compact ? 'gap-1 py-4' : 'gap-2 py-10'"
    data-testid="empty-state"
  >
    <UIcon :name="icon" :class="compact ? 'h-5 w-5' : 'h-8 w-8'" class="text-slate-600" />
    <p :class="compact ? 'text-xs' : 'text-sm'" class="font-medium text-slate-400">
      {{ title }}
    </p>
    <p v-if="description" :class="compact ? 'text-[11px]' : 'text-xs'" class="max-w-xs">
      {{ description }}
    </p>
    <div v-if="$slots.default" :class="compact ? 'mt-1' : 'mt-2'">
      <slot />
    </div>
  </div>
</template>
