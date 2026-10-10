import { hasApproverPolicy } from '@cat-factory/contracts'
import type { Pipeline, StepGateConfig, StepGating, StepOptions } from './types.js'

// ---------------------------------------------------------------------------
// The pipeline AUTHORING helper: a readable list of named steps lowered into the wire
// `Pipeline`'s index-aligned arrays.
//
// It was module-private to the built-in catalog (`seed.ts`) until a deployment registering its
// own pipeline on `PipelineRegistry` had to hand-write those arrays instead. That is a shape the
// platform does not ask its OWN catalog to write, and the reason is the invariant: `agentKinds`,
// `gates`, `enabled`, `gating` and `stepOptions` are index-aligned with each other, so inserting a
// step means shifting four other arrays by eye, in a deployment, with nothing to fail if one is
// missed. Extracted here and exported so the seam a deployment extends through is the one the
// catalog itself is authored with.
// ---------------------------------------------------------------------------

/**
 * One step in the readable authoring form. A bare kind string is an ENABLED step with no human
 * gate; the object form NAMES the step's human `gate` (approval pause), marks it opt-in
 * (`enabled: false` — present in the preset but disabled by default), declares its estimate
 * `gating` (skip the step unless the task estimate clears a threshold), and/or carries the
 * per-step `options` its kind reads (a binary-output step's storage and integration selection, a
 * skill step's `skillId`, a tester's run condition).
 *
 * `gate` is the extension seam it was always meant to be: `true` is a plain human checkpoint, and
 * an OBJECT is that step's gate CONFIGURATION, lowering into `stepOptions[i].gateConfig`, so a
 * configured gate needs no new array and no new column. See
 * `backend/docs/adr/0038-per-step-gate-config.md`.
 *
 * The object form does NOT imply a human checkpoint by itself, because the two halves of
 * `StepGateConfig` answer different questions. `approvers` / `minApprovals` configure the human
 * gate and therefore raise `gates[i]`; `fields` configures the REGISTERED gate the step's kind
 * already runs (a `ci` step's attempt budget, a `post-release-health` step's watch window), which
 * has nothing to do with pausing for a person. Lowering `{ fields: … }` into `gates[i] = true`
 * would bolt a human approval pause onto a `ci` step whose author only wanted three fixer rounds
 * silently, since nothing downstream can tell an intended checkpoint from an inferred one.
 * `assertValidGateConfig` draws the same line at the other door: it requires `gates[i]` for the
 * approval half and never for `fields`.
 *
 * `gate` and `gating` are mutually exclusive on one step, and `validatePipelineShape` enforces
 * that rather than this type: the estimate may ADD a human checkpoint but never cancel an approval
 * pause the author asked for. A pipeline declaring both fails the kernel seed test.
 */
export type PipelineStepSpec =
  | string
  | {
      kind: string
      gate?: boolean | StepGateConfig
      enabled?: boolean
      gating?: StepGating
      /** Non-gate per-step options the kind reads (merged under any `gate` config it declares). */
      options?: StepOptions
    }

/** What {@link definePipeline} takes: the pipeline's identity plus its steps, by name. */
export interface PipelineSpec {
  id: string
  name: string
  description?: string
  /**
   * What this preset exists to do. Required, and required HERE rather than only asserted in the
   * seed test: a preset that skipped it would fall silently out of a narrowed picker rather than
   * fail anything.
   */
  purpose: Pipeline['purpose']
  steps: readonly PipelineStepSpec[]
  availability?: Pipeline['availability']
  labels?: string[]
  version?: number
  public?: boolean
  /** Hide from every user-facing surface; the platform still starts it by id. */
  internal?: boolean
  /**
   * Seed this rung as the workspace's default for a run nothing is watching
   * (`Pipeline.isUnattendedDefault`). There is deliberately no `interactiveDefault` twin: the
   * in-app scope already resolves an answer without a flagged row, so a seeded one would overrule
   * the interface-mode rung a board resolves today (see `Pipeline.isDefault`).
   */
  unattendedDefault?: boolean
}

/**
 * Lower a named-step pipeline spec into the wire {@link Pipeline} (index-aligned
 * `agentKinds`/`gates`/`enabled`/`gating`/`stepOptions`). Each array is emitted ONLY when a step
 * actually declares the corresponding flag, so a plain all-enabled, gate-less pipeline stays as
 * bare `agentKinds`: its persisted shape is byte-identical to the hand-authored form.
 *
 * It validates nothing beyond what the types reach, and deliberately so. A pipeline is judged by
 * `validatePipelineShape` (and `validatePipelineAuthoring` at the write boundary), which every
 * entry point runs and which a registered pipeline reaches on its first run exactly as a stored
 * one does. Re-stating a subset of those rules here would be a second, weaker door.
 */
export function definePipeline(spec: PipelineSpec): Pipeline {
  const norm = spec.steps.map((s) => (typeof s === 'string' ? { kind: s } : s))
  // A human checkpoint is `gate: true`, or an object configuring the APPROVAL half. An object that
  // only carries `fields` configures the step's registered gate and raises no checkpoint. See the
  // `PipelineStepSpec` docs for why conflating the two would be a silent pause nobody authored.
  const gates = norm.map(
    (s) =>
      s.gate === true ||
      (typeof s.gate === 'object' &&
        (hasApproverPolicy(s.gate.approvers) || s.gate.minApprovals !== undefined)),
  )
  const enabled = norm.map((s) => s.enabled !== false)
  const gating = norm.map((s) => s.gating ?? null)
  const stepOptions = norm.map((s) => {
    const options: StepOptions = {
      ...s.options,
      ...(typeof s.gate === 'object' ? { gateConfig: s.gate } : {}),
    }
    return Object.keys(options).length ? options : null
  })
  return {
    id: spec.id,
    name: spec.name,
    ...(spec.description ? { description: spec.description } : {}),
    agentKinds: norm.map((s) => s.kind),
    ...(gates.some(Boolean) ? { gates } : {}),
    ...(enabled.some((e) => !e) ? { enabled } : {}),
    ...(gating.some((g) => g !== null) ? { gating } : {}),
    ...(stepOptions.some((o) => o !== null) ? { stepOptions } : {}),
    ...(spec.availability ? { availability: spec.availability } : {}),
    purpose: spec.purpose,
    ...(spec.labels ? { labels: spec.labels } : {}),
    ...(spec.version !== undefined ? { version: spec.version } : {}),
    ...(spec.public ? { public: spec.public } : {}),
    ...(spec.internal ? { internal: spec.internal } : {}),
    ...(spec.unattendedDefault ? { isUnattendedDefault: true } : {}),
  } as Pipeline
}
