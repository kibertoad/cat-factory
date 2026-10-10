<script setup lang="ts">
// The SPA's one "nothing here yet" render. Every list, panel section and picker that can be empty
// shows this, so an empty state reads the same everywhere (frontend/app/README.md, "Empty states:
// `EmptyState`, always").
//
// It renders Nuxt UI's `UEmpty`, which owns the layout, the type and the theme tokens. This file
// exists for the two things `UEmpty` leaves to each caller and this app wants decided once:
// `compact` (the inline size a narrow inspector section needs, mapped onto `UEmpty`'s `size`) and
// the `naked` variant (an empty state sits INSIDE a panel that already draws its own border, so
// `UEmpty`'s default outline would draw a second box). The default slot is the call-to-action:
// a site with a button to fill the empty list passes it here.
//
// Dumb by design: it takes already-resolved copy and an icon.
withDefaults(
  defineProps<{
    icon?: string
    title: string
    description?: string
    compact?: boolean
  }>(),
  { icon: 'i-lucide-inbox', description: undefined, compact: false },
)
</script>

<template>
  <UEmpty
    variant="naked"
    :size="compact ? 'xs' : 'md'"
    :icon="icon"
    :title="title"
    :description="description"
    :ui="{ root: compact ? 'py-4' : 'py-10' }"
    data-testid="empty-state"
  >
    <template v-if="$slots.default" #actions>
      <slot />
    </template>
  </UEmpty>
</template>
