import { type MaybeRefOrGetter, toValue, watch } from 'vue'
import { useEnvironmentWizardStore } from '~/stores/environmentWizard'

/**
 * Bridge a journey step's target frame (`ModuleEntryProps.input.frameId`) into
 * the `environmentWizard` data store (slice 3 of the modular-vue adoption).
 *
 * The journey owns per-frame NAVIGATION (its state carries the resolved
 * `frameId`), but the heavy per-step DATA lives in the singleton
 * `environmentWizard` store, which holds exactly ONE frame at a time. Every step
 * that READS that store therefore has to (re)assert the frame it was entered for
 * — otherwise the store can be pointing at a DIFFERENT frame than the one the
 * journey is on, and the step renders (or `save()` persists) the wrong frame's
 * recipe. That desync is reachable within a single session: configure frame A up
 * to the preflight step, open the wizard for frame B (its review step repoints
 * the store to B), then reopen A and RESUME at preflight — a step that never
 * re-bridged would show B's data under A's journey.
 *
 * `beginForFrame` is idempotent per frame (a no-op when the store already targets
 * `frameId`), so calling this from every data step is free on the happy path and
 * only re-seeds when the store actually drifted. `immediate` so the store is
 * targeted before the step's first render reads it.
 */
export function useEnvironmentWizardTarget(frameId: MaybeRefOrGetter<string | null>): void {
  const store = useEnvironmentWizardStore()
  watch(
    () => toValue(frameId),
    (id) => store.beginForFrame(id),
    { immediate: true },
  )
}
