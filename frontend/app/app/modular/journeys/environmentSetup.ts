import { defineModule } from '@modular-vue/core'
import { defineExit } from '@modular-frontend/core'
import { defineJourney, defineJourneyHandle } from '@modular-vue/journeys'
import EnvPickStep from '~/components/environments/steps/EnvPickStep.vue'
import EnvReviewStep from '~/components/environments/steps/EnvReviewStep.vue'
import EnvPreflightStep from '~/components/environments/steps/EnvPreflightStep.vue'
import EnvSaveStep from '~/components/environments/steps/EnvSaveStep.vue'
import { catFactoryJourneyPersistence } from '~/modular/journeys/persistence'
import {
  ENV_ADVANCE_EXIT,
  ENV_MODULE_ID,
  ENV_SELECT_EXIT,
  type EnvSelectOutput,
  type EnvSetupInput,
  type EnvSetupState,
  envInitialState,
  envNextAfter,
  envStartStep,
} from '~/modular/journeys/environmentSetup.logic'

/**
 * The environment-setup journey — the slice-3 pilot of the modular-vue adoption
 * (docs/initiatives/modular-vue-adoption.md). It replaces the wizard's hand-rolled
 * `STEP_ORDER` + `step` ref + `goToStep` navigation (in `stores/environmentWizard.ts`)
 * with a typed, back/rewind-capable, resumable journey; the per-step data + async
 * actions stay in that Pinia store, driven by the step components below.
 *
 * Authoring notes (co-evolution): `defineModule` comes from the `@modular-vue/core`
 * binding, but the exit helper `defineExit` is only exported from the neutral
 * `@modular-frontend/core` engine (a direct dep) — the Vue binding doesn't re-export
 * the entry/exit authoring helpers yet. That's a small binding-surface gap to close
 * upstream (mirrors slice 2's remote-manifest re-export), not a blocker.
 *
 * Each step's `input` (the target frame) is threaded explicitly on the `next` step
 * specs rather than via an entry `buildInput` factory: the frame is fixed once at the
 * pick step and never changes mid-flow, so the snapshot input a transition places is
 * always current — even on `preserve-state` back-navigation — which keeps the module
 * type simple (no `buildInput`-optionality quirk) and the flow fully explicit.
 *
 * This file imports the step `.vue` components, so — like `result-views.ts` — it's
 * registered from the client plugin, keeping the unit-tested `registry.ts` /
 * `*.logic.ts` import graph free of SFCs.
 */

/**
 * The step module: one module, four `journey`-mounted entries (the wizard steps),
 * and two exits — `select` (the picker's chosen frame) and `advance` (every other
 * step's void forward). Each non-initial entry opts into `preserve-state` back so
 * the host's Back control rewinds a step without discarding the operator's edits.
 */
export const environmentSetupModule = defineModule({
  id: ENV_MODULE_ID,
  version: '1.0.0',
  entryPoints: {
    pick: { mountKinds: ['journey'] as const, component: EnvPickStep },
    review: {
      mountKinds: ['journey'] as const,
      allowBack: 'preserve-state' as const,
      component: EnvReviewStep,
    },
    preflight: {
      mountKinds: ['journey'] as const,
      allowBack: 'preserve-state' as const,
      component: EnvPreflightStep,
    },
    save: {
      mountKinds: ['journey'] as const,
      allowBack: 'preserve-state' as const,
      component: EnvSaveStep,
    },
  },
  exitPoints: {
    [ENV_SELECT_EXIT]: defineExit<EnvSelectOutput>(),
    [ENV_ADVANCE_EXIT]: defineExit(),
  },
})

type EnvModules = { [ENV_MODULE_ID]: typeof environmentSetupModule }

/**
 * The journey definition. `start` skips the picker when a frame was preselected;
 * transitions are the linear pick → review → preflight → save chain, terminating
 * with `complete` off the save step's `advance`. Back-navigation is handled by the
 * entries' `allowBack`, not explicit transitions.
 */
export const environmentSetupJourney = defineJourney<EnvModules, EnvSetupState>()({
  id: 'environment-setup',
  version: '1.0.0',
  initialState: (input: EnvSetupInput) => envInitialState(input),
  start: (state, input: EnvSetupInput) =>
    envStartStep(state, input) === 'review'
      ? ({ module: ENV_MODULE_ID, entry: 'review', input: { frameId: state.frameId } } as const)
      : ({ module: ENV_MODULE_ID, entry: 'pick', input: { frameId: state.frameId } } as const),
  transitions: {
    [ENV_MODULE_ID]: {
      pick: {
        [ENV_SELECT_EXIT]: (ctx) => ({
          next: {
            module: ENV_MODULE_ID,
            entry: 'review',
            input: { frameId: ctx.output.frameId },
          } as const,
          state: { frameId: ctx.output.frameId },
        }),
      },
      review: {
        [ENV_ADVANCE_EXIT]: (ctx) => ({
          next: {
            module: ENV_MODULE_ID,
            entry: envNextAfter('review'),
            input: { frameId: ctx.state.frameId },
          } as const,
        }),
      },
      preflight: {
        [ENV_ADVANCE_EXIT]: (ctx) => ({
          next: {
            module: ENV_MODULE_ID,
            entry: envNextAfter('preflight'),
            input: { frameId: ctx.state.frameId },
          } as const,
        }),
      },
      // `save` advances to `envNextAfter('save') === 'done'`, i.e. journey completion.
      save: {
        [ENV_ADVANCE_EXIT]: () => ({ complete: undefined }),
      },
    },
  },
})

/** Typed launch handle — callers `runtime.start(handle, { frameId })`. */
export const environmentSetupHandle = defineJourneyHandle(environmentSetupJourney)

/**
 * Pinia-backed persistence keyed by the target frame, so reopening the wizard for
 * the same frame RESUMES at the step it was left on (and a different frame is a
 * fresh flow). A null frame (launched at the picker) is a single transient key.
 */
export const environmentSetupPersistence = catFactoryJourneyPersistence<
  EnvSetupInput,
  EnvSetupState
>(({ journeyId, input }) => `${journeyId}:${input.frameId ?? 'new'}`)
