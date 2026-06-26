import type { Ref, WritableComputedRef } from 'vue'

/**
 * The shared "back to Integrations" handler for an integration sub-panel's modal header.
 * Every panel reached from the Integrations hub closes itself and reopens the hub when its
 * {@link IntegrationBackTitle} Back control fires `@back`. Centralising it keeps the ~13
 * panels from each re-implementing the two-step close-then-reopen inline — which also
 * dodges a Vue SFC-compiler trap: a multi-statement inline template handler
 * (`open = false` ⏎ `ui.openIntegrations()`) is rejected at build time, so callers had to
 * resort to an obscure comma-operator expression. A named handler reads clearly instead.
 *
 * Pass the panel's `open` model (the writable ref/computed bound to its `UModal`).
 */
export function useIntegrationBack(open: Ref<boolean> | WritableComputedRef<boolean>) {
  const ui = useUiStore()
  return () => {
    open.value = false
    ui.openIntegrations()
  }
}
