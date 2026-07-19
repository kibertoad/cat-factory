<script setup lang="ts">
// Shared footer chrome for a modular-vue journey step (slice 3 of the modular-vue
// adoption — docs/initiatives/modular-vue-adoption.md). Renders the Back control
// (wired to the host-provided `goBack`, present only when the current entry
// declared `allowBack` and there's a prior step) plus a `primary` slot for the
// step's own advance affordance, so gating stays local to each step.
const props = defineProps<{
  /** The host-provided rewind callback (`ModuleEntryProps.goBack`), or undefined
   *  on the first step / when back isn't allowed. */
  goBack?: () => void
}>()

const { t } = useI18n()
</script>

<template>
  <div class="flex items-center justify-between border-t border-slate-800 pt-3">
    <UButton
      color="neutral"
      variant="ghost"
      :disabled="!props.goBack"
      icon="i-lucide-arrow-left"
      data-testid="env-setup-back"
      @click="props.goBack?.()"
    >
      {{ t('common.back') }}
    </UButton>
    <slot name="primary" />
  </div>
</template>
