<script setup lang="ts">
// The single, app-wide confirmation dialog. Mounted once in `pages/index.vue` and driven
// entirely by the `useConfirm()` singleton, so any caller can `await confirm({...})` without
// rendering its own modal. UModal already provides the focus trap, Escape-to-close and
// backdrop, so this component adds none of that — it only resolves the pending promise and,
// crucially, resolves `false` whenever the modal closes without an explicit choice.
import { computed, onUnmounted, watch } from 'vue'
import { sharedOverlayStack, type OverlayStackTicket } from '@modular-vue/core'

const { t } = useI18n()
const { open, current, accept, cancel, dismissed } = useConfirm()

// Register on the app's ONE overlay stack for as long as the dialog is up.
//
// The stack is what `useModalBehavior` (`ResultWindowShell`, the lightbox, every modular overlay)
// asks before it handles Escape, and this dialog is a Nuxt UI modal, so without a registration it
// is invisible to that question. A confirm opened FROM a result window then lost the race for its
// own Escape key: the shell's capture-phase listener still believed it was topmost, so it
// preventDefault-ed and re-entered its close request, which supersedes the confirm the user was
// trying to cancel. Pushing a ticket makes the shell stand down while this is on top, which is
// exactly the ordering the stack exists to state.
let ticket: OverlayStackTicket | null = null
function release(): void {
  ticket?.release()
  ticket = null
}
watch(
  open,
  (isOpen) => {
    if (isOpen) ticket ??= sharedOverlayStack.push()
    else release()
  },
  { immediate: true },
)
onUnmounted(release)

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
  <!-- z-[70]: UModal has no z-index of its own, and confirms are triggered from inside
       the app's full-screen z-50 windows (Model Configuration, Human Test) whose
       dropdowns sit at z-[60] — the dialog must stack above both or it opens invisibly
       behind the window. -->
  <UModal
    v-model:open="model"
    :title="current?.title ?? t('common.confirm.defaultTitle')"
    :ui="{ overlay: 'z-[70]', content: 'z-[70] max-w-md' }"
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
