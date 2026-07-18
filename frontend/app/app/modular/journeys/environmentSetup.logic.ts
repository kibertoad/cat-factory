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
 * This file is deliberately free of Vue/`.vue`/`defineModule` imports so the
 * transition graph is unit-tested directly (`environmentSetup.spec.ts`); the
 * component wiring lives in `environmentSetup.ts`, which feeds these helpers into
 * `defineJourney`'s `transitions` map.
 */

/** The journey's ordered step entries (also the module's `entryPoints` keys). */
export const ENV_STEP_ORDER = ['pick', 'review', 'preflight', 'save'] as const
export type EnvStep = (typeof ENV_STEP_ORDER)[number]

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

/** A `StepSpec`-shaped reference to one of this journey's step entries. */
export function envStep(entry: EnvStep): { module: typeof ENV_MODULE_ID; entry: EnvStep } {
  return { module: ENV_MODULE_ID, entry }
}

/** Seed the journey state from the launch input. */
export function envInitialState(input: EnvSetupInput): EnvSetupState {
  return { frameId: input.frameId }
}

/** First step: skip the picker when the launcher already chose a frame. */
export function envStartStep(_state: EnvSetupState, input: EnvSetupInput): EnvStep {
  return input.frameId ? 'review' : 'pick'
}

/**
 * The step reached by advancing from `from` via its forward exit, or `'done'`
 * when the flow completes. The pick step advances via `select` (a distinct
 * exit); the rest via `advance`. Pure and total over `EnvStep`, so the spec pins
 * the whole graph.
 */
export function envNextAfter(from: EnvStep): EnvStep | 'done' {
  switch (from) {
    case 'pick':
      return 'review'
    case 'review':
      return 'preflight'
    case 'preflight':
      return 'save'
    case 'save':
      return 'done'
  }
}
