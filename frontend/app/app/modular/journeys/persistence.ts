import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SerializedJourney } from '@modular-vue/journeys'
import { createPiniaJourneyPersistence } from '@modular-vue/journeys'

/**
 * Pinia-backed journey persistence (slice 3 of the modular-vue adoption —
 * docs/initiatives/modular-vue-adoption.md).
 *
 * A journey's `persistence` adapter is what makes `runtime.start()` mean
 * RESUME: it probes `keyFor(input)` for an in-flight serialized instance and
 * returns it instead of minting a fresh one, so a modal-hosted wizard that is
 * closed and reopened for the same target picks up exactly where it left off
 * (see `JourneyHost`'s start-means-resume contract).
 *
 * We route that through Pinia (via the upstream `createPiniaJourneyPersistence`,
 * the Vue-ecosystem analogue of `createWebStoragePersistence`) rather than a
 * bespoke store: in-flight journeys then participate in the app's existing Pinia
 * devtools/timeline, and one `store.$reset()` drops every persisted journey
 * through a path the app already owns. The binding takes NO `pinia` dependency —
 * the caller (this file) brings the store.
 *
 * Scope is deliberately in-memory / session-only: it survives a modal
 * close→reopen within a session (the demonstrable resume win) but is not wired
 * through `pinia-plugin-persistedstate`, so a full page reload starts fresh.
 * Reload recovery is a later opt-in — a wizard's serialized blob can reference
 * transient run ids that a cross-reload resume would need to re-validate.
 */

/**
 * The single store that owns every wizard journey's serialized blob, keyed by
 * the per-journey `keyFor`. `SerializedJourney` is plain JSON by construction,
 * so the record is trivially (de)serializable.
 */
export const useJourneyPersistenceStore = defineStore('journeyPersistence', () => {
  const journeys = ref<Record<string, SerializedJourney>>({})
  return { journeys }
})

/**
 * Build a Pinia-backed `JourneyPersistence` for a journey, keyed by `keyFor`.
 * Pass the result as a journey registration's `persistence` option. The `store`
 * is a lazy getter so the adapter can be constructed at module-eval time (before
 * any Pinia scope exists) and only resolves the store when the runtime actually
 * loads/saves — inside the client plugin, where Pinia is active.
 *
 * `keyFor` MUST be deterministic for identical input (it's the resume probe
 * key); scope it to the wizard's target (e.g. the service frame id) so reopening
 * the same target resumes and a different target is a fresh flow.
 */
export function catFactoryJourneyPersistence<TInput, TState>(
  keyFor: (ctx: { journeyId: string; input: TInput }) => string,
) {
  return createPiniaJourneyPersistence<TInput, TState>({
    keyFor,
    store: () => useJourneyPersistenceStore(),
  })
}
