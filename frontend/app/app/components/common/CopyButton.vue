<script setup lang="ts">
// Standard icon-only "copy to clipboard" button with confirmation feedback. Routes through
// `useCopyToClipboard` so success/failure is always toasted (UX-38), and carries both a
// `title` and an `aria-label` so it's named for pointer tooltips and screen readers alike.
// Used to make error/detail surfaces copyable (UX-39) — the first thing a user does with a
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
  <UButton
    icon="i-lucide-copy"
    color="neutral"
    variant="ghost"
    :size="size ?? 'xs'"
    :title="label"
    :aria-label="label"
    @click.stop="copy(text)"
  />
</template>
