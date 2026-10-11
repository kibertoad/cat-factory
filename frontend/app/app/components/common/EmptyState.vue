<script setup lang="ts">
// The SPA's one "nothing here yet" render. Every list, panel section and picker that can be empty
// shows this, so an empty state reads the same everywhere (frontend/app/README.md, "Empty states:
// `EmptyState`, always").
//
// It renders Nuxt UI's `UEmpty`, which owns the structure, the call-to-action row and the theme
// tokens. This file decides what `UEmpty` leaves to each caller, once:
//
// - The `naked` variant: an empty state sits INSIDE a panel that already draws its own border, so
//   `UEmpty`'s default outline would draw a second box.
// - The spacing. `UEmpty`'s root pads `p-4 sm:p-6 lg:p-8` with a `gap-4`, sized for a page body.
//   Every responsive step is reset here, because overriding the base `p-4` alone leaves 32px of
//   padding inside a narrow picker at desktop widths.
// - The header markup. `UEmpty` renders its title as an `<h2>`, which would put a level-2 heading
//   into every picker, dropdown and inspector section. The header slot renders the copy as plain
//   text instead.
//
// The default slot is the call-to-action: a site with a button to fill the empty list passes it
// here. Dumb by design: it takes already-resolved copy and an icon.
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
    :ui="{
      root: compact
        ? 'gap-1 p-0 py-4 sm:p-0 sm:py-4 lg:p-0 lg:py-4'
        : 'gap-2 p-0 py-10 sm:p-0 sm:py-10 lg:p-0 lg:py-10',
      header: compact ? 'gap-1' : 'gap-2',
    }"
    data-testid="empty-state"
  >
    <template #header>
      <UIcon :name="icon" :class="compact ? 'size-5' : 'size-8'" class="text-app-600" />
      <p :class="compact ? 'text-xs' : 'text-sm'" class="font-medium text-muted">{{ title }}</p>
      <p
        v-if="description"
        :class="compact ? 'text-2xs' : 'text-xs'"
        class="text-balance text-dimmed"
      >
        {{ description }}
      </p>
    </template>
    <template v-if="$slots.default" #actions>
      <slot />
    </template>
  </UEmpty>
</template>
