import { readonly, ref } from 'vue'

/**
 * A shared, promise-based confirmation dialog. Call `confirm(...)` from anywhere and
 * `await` the boolean the user chose — resolve on Confirm, reject-to-`false` on Cancel or
 * any dismissal (backdrop click, Escape, route change). One `<ConfirmDialog />` is mounted
 * app-wide (in `pages/index.vue`) and reads this singleton, so callers never render a modal
 * themselves — they just `await useConfirm().confirm({...})` and branch on the result.
 *
 * The state lives at module scope (outside the exported function) so every caller and the
 * single mounted dialog share ONE request queue.
 */
export interface ConfirmRequest {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  /** `destructive` renders the confirm button in the error colour. */
  variant?: 'default' | 'destructive'
  icon?: string
}

const open = ref(false)
const current = ref<ConfirmRequest | null>(null)
let resolver: ((ok: boolean) => void) | null = null

/** Settle the pending promise (if any) with `ok`, then clear it. */
function settle(ok: boolean): void {
  const resolve = resolver
  resolver = null
  resolve?.(ok)
}

export function useConfirm() {
  function confirm(request: ConfirmRequest): Promise<boolean> {
    // A new request while one is open supersedes the old one — resolve the previous
    // `false` so its awaiter never hangs, then show the new request.
    if (resolver) settle(false)
    current.value = request
    open.value = true
    return new Promise<boolean>((resolve) => {
      resolver = resolve
    })
  }

  function accept(): void {
    open.value = false
    settle(true)
  }

  function cancel(): void {
    open.value = false
    settle(false)
  }

  // Called by the dialog when `open` flips to false without an explicit accept/cancel
  // (backdrop, Escape, unmount). Any still-pending promise resolves `false`.
  function dismissed(): void {
    if (resolver) settle(false)
  }

  return { open, current: readonly(current), confirm, accept, cancel, dismissed }
}
