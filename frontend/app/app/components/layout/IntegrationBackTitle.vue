<script setup lang="ts">
// Title content for an integration sub-panel's modal header. Renders the panel
// title with a leading "back" control that returns to the Integrations hub, shown
// only when the panel was actually reached from there (`ui.cameFromIntegrations`).
// Panels opened from the command bar, sidebar, a banner or an inspector link don't
// grow a dead Back. Dropped into a UModal's #title slot, so it inherits the modal's
// title styling; it emits `back` and the host panel closes itself + reopens the hub.
defineProps<{ title?: string }>()
const emit = defineEmits<{ back: [] }>()
const ui = useUiStore()
</script>

<template>
  <span class="flex items-center gap-1.5">
    <UButton
      v-if="ui.cameFromIntegrations"
      icon="i-lucide-arrow-left"
      color="neutral"
      variant="ghost"
      size="xs"
      class="-ml-1.5 shrink-0"
      aria-label="Back to Integrations"
      @click.stop="emit('back')"
    />
    <span class="min-w-0 truncate">{{ title }}</span>
  </span>
</template>
