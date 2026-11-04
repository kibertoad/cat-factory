import * as v from 'valibot'
import type { StepGating } from './consensus.js'
import type { StepOptions } from './entities.js'
import { stepGateConfigSchema } from './gate-config.js'

/**
 * The APPROVAL half of a step's gate configuration: who may clear its human approval gate and how
 * many of them must. The registered gate's own parameters (`fields`) are deliberately absent: they
 * tune how a `ci` or `conflicts` step behaves, which is the pipeline's structure, and a built-in's
 * structure is the catalog's to define.
 */
export const approvalPolicySchema = v.pick(stepGateConfigSchema, ['approvers', 'minApprovals'])
export type ApprovalPolicy = v.InferOutput<typeof approvalPolicySchema>

/**
 * Replace a pipeline's human approval checkpoints, and nothing else. Accepted on every pipeline,
 * BUILT-INS included: a checkpoint is how much oversight a workspace wants on the work, not part of
 * the chain the catalog defines, so a board can add one without cloning the built-in off its
 * catalog updates.
 *
 * Both arrays are parallel to the pipeline's `agentKinds` and must match its length, so a request
 * composed against a stale copy of the chain is refused rather than landing on the wrong steps.
 * `policies` absent leaves every step's stored approver policy as it is; an entry of `null` clears
 * that step's policy back to the default (one approval from anyone entitled to write).
 */
export const setPipelineApprovalsSchema = v.object({
  gates: v.array(v.boolean()),
  policies: v.optional(v.array(v.nullable(approvalPolicySchema))),
})
export type SetPipelineApprovalsInput = v.InferOutput<typeof setPipelineApprovalsSchema>

/**
 * The checkpoints a built-in's CATALOG definition ships: its chain and the gate flags aligned to
 * it. Served on the workspace snapshot (`pipelineCatalogApprovals`) so the builder can show those
 * checkpoints as part of the built-in rather than as ones the workspace may switch off.
 */
export const catalogApprovalsSchema = v.object({
  agentKinds: v.array(v.string()),
  gates: v.array(v.boolean()),
})
export type CatalogApprovals = v.InferOutput<typeof catalogApprovalsSchema>

/**
 * A step's identity across two versions of one chain: its kind plus how many earlier steps share
 * that kind (`architect#0`, `tester-api#1`).
 *
 * Positions cannot carry a checkpoint from one version to the next, because a catalog update that
 * inserts a step shifts every index after it and would land the Architect's checkpoint on the
 * Coder. A kind alone cannot either, because a chain may run the same kind twice.
 */
export function stepOccurrenceKeys(agentKinds: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return agentKinds.map((kind) => {
    const occurrence = seen.get(kind) ?? 0
    seen.set(kind, occurrence + 1)
    return `${kind}#${occurrence}`
  })
}

/**
 * For each step of `agentKinds`, whether the catalog definition ships a checkpoint on the same
 * step (matched by {@link stepOccurrenceKeys}). These are the checkpoints a workspace may not
 * remove from a built-in: they are part of what the built-in is, and the only way to drop one is
 * a clone. All `false` when the pipeline has no catalog definition.
 */
export function catalogGatedSteps(
  agentKinds: readonly string[],
  catalog: CatalogApprovals | undefined,
): boolean[] {
  if (!catalog) return agentKinds.map(() => false)
  const shipped = new Set(
    stepOccurrenceKeys(catalog.agentKinds).filter((_, i) => catalog.gates[i] === true),
  )
  return stepOccurrenceKeys(agentKinds).map((key) => shipped.has(key))
}

/**
 * For each step of a stored built-in row, whether its checkpoint is LOCKED: the catalog ships it
 * ({@link catalogGatedSteps}) and the row carries it. Switching one of these off is the removal a
 * built-in refuses. A shipped checkpoint a row does not carry (a copy older than the catalog
 * version that added it) is not locked: leaving it off removes nothing, and a reseed adopts it.
 */
export function lockedCheckpoints(
  row: { agentKinds: readonly string[]; gates?: readonly boolean[] },
  catalog: CatalogApprovals | undefined,
): boolean[] {
  return catalogGatedSteps(row.agentKinds, catalog).map(
    (shipped, i) => shipped && row.gates?.[i] === true,
  )
}

/** The approval half of a step's stored gate configuration, or null when it takes the defaults. */
export function approvalPolicyOf(options: StepOptions | null | undefined): ApprovalPolicy | null {
  const config = options?.gateConfig
  if (!config) return null
  const policy: ApprovalPolicy = {}
  if (config.approvers) policy.approvers = config.approvers
  if (config.minApprovals !== undefined) policy.minApprovals = config.minApprovals
  return Object.keys(policy).length ? policy : null
}

/** The parts of a pipeline that decide whether a step may be skipped on a run. */
export interface SkippableStepsShape {
  agentKinds: readonly string[]
  enabled?: readonly boolean[]
  gating?: readonly (StepGating | null | undefined)[]
  stepOptions?: readonly (StepOptions | null | undefined)[]
}

/** Whether a run may skip step `index`: it is estimate-gated or carries a run condition. */
export function stepMaySkip(shape: SkippableStepsShape, index: number): boolean {
  return shape.gating?.[index]?.enabled === true || !!shape.stepOptions?.[index]?.condition
}

/**
 * The step whose skip would cancel a human approval checkpoint on step `index`, or null when a
 * checkpoint there is always reached. That is the step itself when it may be skipped, and for a
 * COMPANION also the producer it reviews (the nearest preceding enabled step), because a companion
 * is skipped whenever its producer is. The backend refuses a checkpoint this names; the SPA does not
 * offer one.
 */
export function checkpointSkippedBy(
  shape: SkippableStepsShape,
  index: number,
  isCompanion: (kind: string) => boolean,
): number | null {
  if (stepMaySkip(shape, index)) return index
  const kind = shape.agentKinds[index]
  if (kind === undefined || !isCompanion(kind)) return null
  let producer = index - 1
  while (producer >= 0 && shape.enabled?.[producer] === false) producer--
  return producer >= 0 && stepMaySkip(shape, producer) ? producer : null
}
