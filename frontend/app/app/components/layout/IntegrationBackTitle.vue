<script setup lang="ts">
// Title content for an integration sub-panel's modal header. Renders the panel
// title with a leading "back" control that returns to the hub the panel was reached
// from — the workspace Integrations hub (`ui.cameFromIntegrations`) or the user-scoped
// "My setup" hub (`ui.cameFromPersonal`) — shown only when there is one. Panels opened
// from the command bar, sidebar, a banner or an inspector link don't grow a dead Back.
// Dropped into a UModal's #title slot, so it inherits the modal's title styling; it
// emits `back` and the host panel closes itself + reopens the right hub.
defineProps<{ title?: string }>()
const emit = defineEmits<{ back: [] }>()
const { t } = useI18n()
const ui = useUiStore()
const cameFromHub = computed(() => ui.cameFromIntegrations || ui.cameFromPersonal)
const backLabel = computed(() =>
  ui.cameFromPersonal
    ? t('layout.integrationBack.backToMySetup')
    : t('layout.integrationBack.backToIntegrations'),
)
</script>

<template>
  <span class="flex items-center gap-1.5">
    <UButton
      v-if="cameFromHub"
      icon="i-lucide-arrow-left"
      color="neutral"
      variant="ghost"
      size="xs"
      class="-ml-1.5 shrink-0"
      :aria-label="backLabel"
      @click.stop="emit('back')"
    />
    <span class="min-w-0 truncate">{{ title }}</span>
  </span>
</template>
