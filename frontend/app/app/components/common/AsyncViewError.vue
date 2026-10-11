<script setup lang="ts">
// Shown in place of a code-split surface whose chunk failed to load. See `utils/asyncView.ts`
// for why every async surface gets one.
const { t } = useI18n()

function reload() {
  window.location.reload()
}
</script>

<template>
  <!-- safe-area-ok: a scrim with one card centred on it, so no content reaches an edge -->
  <div
    data-testid="async-view-error"
    class="fixed inset-0 z-50 grid place-items-center bg-elevated/75 p-6 backdrop-blur-sm"
    role="alert"
  >
    <div class="max-w-sm rounded-2xl border border-muted bg-default p-5 shadow-2xl">
      <div class="flex items-center gap-2 text-sm font-semibold text-app-100">
        <UIcon name="i-lucide-unplug" class="h-4 w-4 shrink-0 text-app-warning-400" />
        {{ t('errors.asyncView.title') }}
      </div>
      <p class="mt-2 text-xs leading-relaxed text-muted">
        {{ t('errors.asyncView.body') }}
      </p>
      <UButton class="mt-4" variant="soft" size="xs" @click="reload">
        {{ t('errors.asyncView.reload') }}
      </UButton>
    </div>
  </div>
</template>
