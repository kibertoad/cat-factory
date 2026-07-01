<script setup lang="ts">
// The single, app-wide confirmation dialog. Mounted once in `pages/index.vue` and driven
// entirely by the `useConfirm()` singleton, so any caller can `await confirm({...})` without
// rendering its own modal. UModal already provides the focus trap, Escape-to-close and
// backdrop, so this component adds none of that — it only resolves the pending promise and,
// crucially, resolves `false` whenever the modal closes without an explicit choice.

const { t } = useI18n()
const { open, current, accept, cancel, dismissed } = useConfirm()

const model = computed({
  get: () => open.value,
  set: (v: boolean) => {
    // The user dismissed via backdrop / Escape — treat as cancel so the promise settles.
    if (!v) dismissed()
  },
})

const isDestructive = computed(() => current.value?.variant === 'destructive')
</script>

<template>
  <UModal
    v-model:open="model"
    :title="current?.title ?? t('common.confirm.defaultTitle')"
    :ui="{ content: 'max-w-md' }"
  >
    <template #body>
      <div class="flex items-start gap-3" data-testid="confirm-dialog">
        <div
          v-if="current?.icon"
          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
          :class="isDestructive ? 'bg-red-500/10 text-red-400' : 'bg-slate-700/40 text-slate-300'"
        >
          <UIcon :name="current.icon" class="h-5 w-5" />
        </div>
        <p v-if="current?.description" class="text-sm text-slate-300">
          {{ current.description }}
        </p>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" data-testid="confirm-cancel" @click="cancel">
          {{ current?.cancelLabel ?? t('common.cancel') }}
        </UButton>
        <UButton
          :color="isDestructive ? 'error' : 'primary'"
          data-testid="confirm-accept"
          autofocus
          @click="accept"
        >
          {{ current?.confirmLabel ?? t('common.confirm.confirm') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
