import type { Ref, WritableComputedRef } from 'vue'

/**
 * The shared "back to the hub" handler for an integration sub-panel's modal header.
 * Every panel reached from a hub closes itself and reopens that hub when its
 * {@link IntegrationBackTitle} Back control fires `@back`. Centralising it keeps the ~13
 * panels from each re-implementing the two-step close-then-reopen inline — which also
 * dodges a Vue SFC-compiler trap: a multi-statement inline template handler
 * (`open = false` ⏎ `ui.openIntegrations()`) is rejected at build time, so callers had to
 * resort to an obscure comma-operator expression. A named handler reads clearly instead.
 *
 * Returns to whichever hub the panel was reached from: the user-scoped "My setup" hub when
 * `cameFromPersonal` is set, else the workspace Integrations hub. A shared panel (e.g. the
 * vendor-credentials modal, reachable from both) thus lands the user back where they were.
 *
 * Pass the panel's `open` model (the writable ref/computed bound to its `UModal`).
 */
export function useIntegrationBack(open: Ref<boolean> | WritableComputedRef<boolean>) {
  const ui = useUiStore()
  return () => {
    const toPersonal = ui.cameFromPersonal
    open.value = false
    if (toPersonal) ui.openPersonalSetup()
    else ui.openIntegrations()
  }
}
