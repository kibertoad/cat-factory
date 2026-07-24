import type { Component } from 'vue'
import { resolveComponentRegistry } from '@modular-vue/core'
import type { OverlayContribution } from '~/modular/slots'

/**
 * Pure selection for `<AppOverlayHost>` (extension slice D). Indexes the merged `appOverlays`
 * slot into an id → component registry (`resolveComponentRegistry` — the same pick-one primitive
 * `StepResultViewHost` uses; duplicate ids throw, as validated once at boot) and picks the entry
 * matching the active overlay id.
 *
 * Kept side-effect-free — the host's dev-warn for a dangling open lives in a `watchEffect`, not
 * here — so both the host's `computed` and the unit spec can call it. `missing` is the explicit
 * dangling-open signal (an id with no registered component, e.g. a stale nav closure after an
 * extension was removed): the host degrades that to nothing rather than crashing.
 */
export function selectOverlay(
  overlays: OverlayContribution[],
  activeId: string | null | undefined,
): { component: Component | null; missing: boolean } {
  if (!activeId) return { component: null, missing: false }
  const registry = resolveComponentRegistry(overlays)
  const component = (registry.get(activeId) as Component | undefined) ?? null
  return { component, missing: !component }
}
