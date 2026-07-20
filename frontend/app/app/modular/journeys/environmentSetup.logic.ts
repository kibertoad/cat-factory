/**
 * Pure navigation logic for the environment-setup journey (slice 3 of the
 * modular-vue adoption — docs/initiatives/modular-vue-adoption.md).
 *
 * The journey owns only the WIZARD NAVIGATION — the ordered steps
 * (pick → review → preflight → save), the forward transitions, and the
 * back/rewind + resume that used to live as a hand-rolled `STEP_ORDER` + `step`
 * ref + `goToStep` in `stores/environmentWizard.ts`. The heavy per-step DATA and
 * async actions (detect / deep-analysis / recipe editing / preflight / save /
 * trial) stay in that Pinia store, which the step components still drive; the
 * journey just decides WHICH step shows and threads the target frame id.
 *
 * The step ORDER is no longer spelled out a second time as an ordered array: it
 * is DERIVED from the annotated transition graph below (production-feedback item
 * 4 in modular-react#83). Each transition wraps its handler with
 * `defineTransition({ targets, handle })` so the static `targets` declare where
 * the flow can go; `resolveStepSequence` / `useJourneyProgress` walk that graph
 * to produce the ordered step list and the wizard's "Step X of N" progress from
 * the one place the flow is encoded. `steps` carries each step's progress-label
 * key beside the transitions.
 *
 * This definition lives in the logic file (not the SFC-importing
 * `environmentSetup.ts`) so the graph stays free of `.vue` imports and is
 * unit-tested directly (`environmentSetup.logic.spec.ts`). It references the step
 * module only as a TYPE (`import type`), which is erased at runtime, so importing
 * this file pulls no components. `environmentSetup.ts` supplies the module (with
 * its step components) and re-exports the journey + the launch handle + the
 * persistence adapter.
 */
import type { ExitCtx } from '@modular-vue/journeys'
import { defineJourney, defineTransition } from '@modular-vue/journeys'
import type { environmentSetupModule } from '~/modular/journeys/environmentSetup'

/** The single module id every step entry lives under. */
export const ENV_MODULE_ID = 'cat-factory:environment-setup' as const

/** The picker's exit — carries the chosen frame into journey state. */
export const ENV_SELECT_EXIT = 'select'
/** Every other step's forward exit — void, just advances. */
export const ENV_ADVANCE_EXIT = 'advance'

/** Payload of the picker's `select` exit. */
export interface EnvSelectOutput {
  frameId: string
}

/** The journey's serializable state — just the resolved target frame. Everything
 *  else is derived live in the `environmentWizard` store, so this stays tiny and
 *  cheap to persist/resume. */
export interface EnvSetupState {
  frameId: string | null
}

/** The journey's start input — the frame the launcher preselected, or `null` to
 *  begin at the pick step. `keyFor` scopes resume to this frame. */
export interface EnvSetupInput {
  frameId: string | null
}

/** Seed the journey state from the launch input. */
export function envInitialState(input: EnvSetupInput): EnvSetupState {
  return { frameId: input.frameId }
}

/** First step: skip the picker when the launcher already chose a frame. */
export function envStartStep(_state: EnvSetupState, input: EnvSetupInput): 'pick' | 'review' {
  return input.frameId ? 'review' : 'pick'
}

/**
 * The journey's module type map — one module, referenced by its `typeof` so the
 * transition + step maps resolve its literal entry/exit vocabulary with no casts.
 * This is the case production-feedback item 3 (modular-react#83) fixed: before it,
 * `defineModule` widened the descriptor, so `typeof environmentSetupModule` could
 * not stand in as a `TModules` member without re-declaring the entry names by hand.
 */
export type EnvModules = { [ENV_MODULE_ID]: typeof environmentSetupModule }

/** Binder threading the journey generics into each annotated transition handler. */
const transition = defineTransition<EnvModules, EnvSetupState>()

/**
 * The journey definition. `start` skips the picker when a frame was preselected.
 * The forward chain is the annotated transitions' `targets`: pick →(select)→
 * review →(advance)→ preflight →(advance)→ save →(advance)→ complete. Back
 * navigation is handled by the entries' `allowBack` (declared on the module in
 * `environmentSetup.ts`), not explicit transitions.
 */
export const environmentSetupJourney = defineJourney<EnvModules, EnvSetupState>()({
  id: 'environment-setup',
  version: '1.0.0',
  initialState: (input: EnvSetupInput) => envInitialState(input),
  start: (state, input: EnvSetupInput) =>
    envStartStep(state, input) === 'review'
      ? { module: ENV_MODULE_ID, entry: 'review', input: { frameId: state.frameId } }
      : { module: ENV_MODULE_ID, entry: 'pick', input: { frameId: state.frameId } },
  steps: {
    [ENV_MODULE_ID]: {
      pick: { progressLabel: 'environmentWizard.steps.pick' },
      review: { progressLabel: 'environmentWizard.steps.review' },
      preflight: { progressLabel: 'environmentWizard.steps.preflight' },
      save: { progressLabel: 'environmentWizard.steps.save' },
    },
  },
  transitions: {
    [ENV_MODULE_ID]: {
      pick: {
        [ENV_SELECT_EXIT]: transition({
          targets: [{ module: ENV_MODULE_ID, entry: 'review' }],
          handle: (ctx: ExitCtx<EnvSetupState, EnvSelectOutput, unknown>) => ({
            next: {
              module: ENV_MODULE_ID,
              entry: 'review',
              input: { frameId: ctx.output.frameId },
            },
            state: { frameId: ctx.output.frameId },
          }),
        }),
      },
      review: {
        [ENV_ADVANCE_EXIT]: transition({
          targets: [{ module: ENV_MODULE_ID, entry: 'preflight' }],
          handle: (ctx) => ({
            next: {
              module: ENV_MODULE_ID,
              entry: 'preflight',
              input: { frameId: ctx.state.frameId },
            },
          }),
        }),
      },
      preflight: {
        [ENV_ADVANCE_EXIT]: transition({
          targets: [{ module: ENV_MODULE_ID, entry: 'save' }],
          handle: (ctx) => ({
            next: {
              module: ENV_MODULE_ID,
              entry: 'save',
              input: { frameId: ctx.state.frameId },
            },
          }),
        }),
      },
      // `save` advances to journey completion.
      save: {
        [ENV_ADVANCE_EXIT]: transition({
          targets: ['complete'],
          handle: () => ({ complete: undefined }),
        }),
      },
    },
  },
})
