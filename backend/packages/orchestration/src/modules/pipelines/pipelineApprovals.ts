import {
  approvalPolicyOf,
  catalogGatedSteps,
  stepOccurrenceKeys,
  type ApprovalPolicy,
  type CatalogApprovals,
  type SetPipelineApprovalsInput,
} from '@cat-factory/contracts'
import { hasApproverPolicy, ValidationError } from '@cat-factory/kernel'
import type { Pipeline, StepGateConfig, StepOptions } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// A pipeline's human approval CHECKPOINTS as their own write: the `gates[i]` flags plus the
// approval half of each step's `stepOptions[i].gateConfig`. Separate from the structural update
// because it is the one change a BUILT-IN accepts: how much oversight a workspace wants on its work
// is the workspace's to decide, while the chain the catalog defines is not.
//
// A built-in's row then holds the catalog's checkpoints AND the ones the workspace added, with
// nothing recording which is which. So a workspace may ADD checkpoints to a built-in but never
// remove one the catalog ships, which is what lets a reseed rebuild the row as the union of the
// two instead of having to remember a removal.
// ---------------------------------------------------------------------------

/** The catalog half of a pipeline, in the shape {@link catalogGatedSteps} reads. */
export function catalogApprovalsOf(seed: Pipeline | undefined): CatalogApprovals | undefined {
  return seed ? { agentKinds: seed.agentKinds, gates: seed.gates ?? [] } : undefined
}

/**
 * The `gates` and `stepOptions` a set-approvals request leaves on `existing`, or a refusal.
 *
 * Refuses arrays that do not match the chain (a request composed against a stale copy would
 * otherwise land on the wrong steps) and, on a built-in, the removal of a checkpoint its catalog
 * definition ships. A step whose checkpoint is off loses its approver policy too: a policy on a
 * step nobody is asked about names a checkpoint that does not exist.
 *
 * The result is not shape-validated here; the caller validates the whole pipeline it composes.
 */
export function approvalsApplied(
  existing: Pipeline,
  input: SetPipelineApprovalsInput,
  catalog: CatalogApprovals | undefined,
): Pick<Pipeline, 'gates' | 'stepOptions'> {
  const steps = existing.agentKinds.length
  if (input.gates.length !== steps || (input.policies && input.policies.length !== steps)) {
    throw new ValidationError(
      `The approval checkpoints name ${input.gates.length} steps, but this pipeline has ${steps}. Reload the pipeline and try again.`,
    )
  }
  if (existing.builtin) {
    const shipped = catalogGatedSteps(existing.agentKinds, catalog)
    const removed = existing.agentKinds.filter((_, i) => shipped[i] && !input.gates[i])
    if (removed.length) {
      throw new ValidationError(
        `The checkpoint after ${removed.map((kind) => `'${kind}'`).join(', ')} is part of the built-in pipeline '${existing.name}'. Clone the pipeline to remove it.`,
      )
    }
  }
  const stepOptions = existing.agentKinds.map((_, i) => {
    const current = existing.stepOptions?.[i] ?? null
    if (!input.gates[i]) return withApprovalPolicy(current, null)
    return input.policies ? withApprovalPolicy(current, input.policies[i] ?? null) : current
  })
  return {
    ...(input.gates.some(Boolean) ? { gates: [...input.gates] } : { gates: undefined }),
    ...(stepOptions.some((o) => o !== null) ? { stepOptions } : { stepOptions: undefined }),
  }
}

/**
 * Replace the approval half of a step's gate configuration, keeping its gate parameters and every
 * other option. Normalizes downward the way the builder does, so a step returned to the defaults
 * persists nothing: an empty approver policy is dropped (one naming nobody would refuse every
 * approver and park the run forever), and so is a quorum of 1, which is the default.
 */
function withApprovalPolicy(
  options: StepOptions | null,
  policy: ApprovalPolicy | null,
): StepOptions | null {
  const {
    approvers: _approvers,
    minApprovals: _minApprovals,
    ...parameters
  } = options?.gateConfig ?? {}
  const gateConfig: StepGateConfig = { ...parameters }
  if (policy?.approvers && hasApproverPolicy(policy.approvers)) {
    gateConfig.approvers = policy.approvers
  }
  if (policy?.minApprovals !== undefined && policy.minApprovals > 1) {
    gateConfig.minApprovals = policy.minApprovals
  }
  const next: StepOptions = { ...options }
  if (Object.keys(gateConfig).length) next.gateConfig = gateConfig
  else delete next.gateConfig
  return Object.keys(next).length ? next : null
}

/** What a reseed kept of the workspace's checkpoints, and which ones the new definition refused. */
export interface CarriedApprovals {
  pipeline: Pipeline
  /** The step kinds whose checkpoint could not be carried onto the new definition. */
  dropped: string[]
}

/**
 * Carry a workspace's checkpoints from its stored copy of a built-in onto the catalog row a reseed
 * is about to write.
 *
 * Each checkpoint is matched to the same STEP of the new definition by {@link stepOccurrenceKeys},
 * never by position: a catalog version that inserts a step would otherwise move the Architect's
 * checkpoint onto the Coder. Each one is then kept only if the new definition still admits it (it
 * may have made that step estimate-gated, which no checkpoint may sit on), and a checkpoint whose
 * step left the chain, or that the definition refuses, is DROPPED and named in the result so the
 * caller can say so rather than silently shrinking the oversight somebody asked for.
 *
 * The approver policy travels with its checkpoint, onto a checkpoint the catalog ships as much as
 * onto one the workspace added.
 */
export function carriedApprovals(
  seed: Pipeline,
  existing: Pipeline,
  admits: (candidate: Pipeline) => boolean,
): CarriedApprovals {
  const stored = new Map<string, ApprovalPolicy | null>()
  stepOccurrenceKeys(existing.agentKinds).forEach((key, i) => {
    if (existing.gates?.[i] === true) stored.set(key, approvalPolicyOf(existing.stepOptions?.[i]))
  })
  let pipeline = seed
  const dropped: string[] = []
  const seedKeys = stepOccurrenceKeys(seed.agentKinds)
  seedKeys.forEach((key, i) => {
    if (!stored.has(key)) return
    const policy = stored.get(key) ?? null
    const candidate: Pipeline = {
      ...pipeline,
      ...approvalsApplied(
        { ...pipeline, builtin: false },
        {
          gates: pipeline.agentKinds.map((_, j) => j === i || pipeline.gates?.[j] === true),
          policies: pipeline.agentKinds.map((_, j) =>
            j === i ? policy : approvalPolicyOf(pipeline.stepOptions?.[j]),
          ),
        },
        undefined,
      ),
    }
    if (admits(candidate)) pipeline = candidate
    else dropped.push(seed.agentKinds[i]!)
  })
  const kept = new Set(seedKeys)
  stepOccurrenceKeys(existing.agentKinds).forEach((key, i) => {
    if (stored.has(key) && !kept.has(key)) dropped.push(existing.agentKinds[i]!)
  })
  return { pipeline, dropped }
}
