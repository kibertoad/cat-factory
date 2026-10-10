<script setup lang="ts">
// Standard icon-only "copy to clipboard" button with confirmation feedback. Routes through
// `useCopyToClipboard` so success/failure is always toasted (UX-38), and carries both a
// tooltip and an `aria-label` so it's named for pointer users and screen readers alike.
// Used to make error/detail surfaces copyable (UX-39): the first thing a user does with a
// stack trace or failure summary is copy it.
const props = defineProps<{
  /** The text to place on the clipboard. */
  text: string
  /** Accessible name + tooltip; defaults to the generic "Copy". */
  label?: string
  size?: 'xs' | 'sm' | 'md'
}>()

const { t } = useI18n()
const { copy } = useCopyToClipboard()
const label = computed(() => props.label ?? t('common.copy'))
</script>

<template>
  <UTooltip :text="label">
    <UButton
      icon="i-lucide-copy"
      color="neutral"
      variant="ghost"
      :size="size ?? 'xs'"
      :aria-label="label"
      @click.stop="copy(text)"
    />
  </UTooltip>
</template>
