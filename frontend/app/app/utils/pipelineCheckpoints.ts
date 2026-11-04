import {
  approvalPolicyOf,
  checkpointSkippedBy,
  hasApproverPolicy,
  stepOccurrenceKeys,
  type SkippableStepsShape,
  type StepGateConfig,
  type StepOptions,
} from '@cat-factory/contracts'
import type { AgentKind, Pipeline } from '~/types/domain'
import { companionForProducer, isProducerCompanion } from '~/utils/catalog'

/**
 * One row of a pipeline as the builder shows it: a step, with the companion that sits immediately
 * after it folded in (`companionIndex`) rather than drawn as a row of its own. A companion that is
 * NOT directly after its producer stays a unit of its own, so every index belongs to exactly one
 * unit. `index` and `companionIndex` are positions in the pipeline's `agentKinds`.
 */
export interface PipelineUnit {
  index: number
  kind: AgentKind
  companionIndex: number | null
}

export function foldCompanionUnits(agentKinds: readonly AgentKind[]): PipelineUnit[] {
  const out: PipelineUnit[] = []
  let folded = -1
  for (let i = 0; i < agentKinds.length; i++) {
    const kind = agentKinds[i]
    if (kind === undefined || i === folded) continue
    const companion = companionForProducer(kind)
    const companionIndex = companion && agentKinds[i + 1] === companion ? i + 1 : null
    if (companionIndex !== null) folded = companionIndex
    out.push({ index: i, kind, companionIndex })
  }
  return out
}

/**
 * Where a producer-and-companion pair pauses for a person. The two are separate steps, so each can
 * carry its own approval gate, and they mean different things: the producer's fires on EVERY draft,
 * including each rework round the companion sends back, while the companion's fires once, on the
 * draft it passed.
 */
export type CheckpointPlacement = 'none' | 'producer' | 'companion' | 'both'

export const CHECKPOINT_PLACEMENTS: readonly CheckpointPlacement[] = [
  'none',
  'producer',
  'companion',
  'both',
]

export function checkpointPlacement(
  producerGated: boolean,
  companionGated: boolean,
): CheckpointPlacement {
  if (producerGated && companionGated) return 'both'
  if (producerGated) return 'producer'
  if (companionGated) return 'companion'
  return 'none'
}

export function placementGates(placement: CheckpointPlacement): {
  producer: boolean
  companion: boolean
} {
  return {
    producer: placement === 'producer' || placement === 'both',
    companion: placement === 'companion' || placement === 'both',
  }
}

/**
 * Merge a patch into a step's gate configuration and return the step's new options bag.
 *
 * Normalizes downward at every level: a field set back to its default is deleted, an emptied
 * `gateConfig` is dropped, and an emptied options bag becomes `null`, so a step returned to the
 * defaults persists nothing. An empty approver policy is dropped rather than stored, and that one
 * is not just tidiness: `{ roles: [] }` names nobody, and a policy naming nobody would refuse every
 * approver and park the run forever.
 */
export function patchedGateConfig(
  options: StepOptions | null | undefined,
  patch: Partial<StepGateConfig>,
): StepOptions | null {
  const gateConfig: StepGateConfig = { ...options?.gateConfig, ...patch }
  if (!hasApproverPolicy(gateConfig.approvers)) delete gateConfig.approvers
  if (gateConfig.minApprovals !== undefined && gateConfig.minApprovals <= 1) {
    delete gateConfig.minApprovals
  }
  if (gateConfig.fields && Object.keys(gateConfig.fields).length === 0) delete gateConfig.fields
  const next: StepOptions = { ...options }
  if (Object.keys(gateConfig).length) next.gateConfig = gateConfig
  else delete next.gateConfig
  return Object.keys(next).length ? next : null
}

/**
 * The steps whose checkpoint a reseed did not keep: gated on the row before it, matched to the same
 * step of the row after it, and not gated there. The backend drops a checkpoint the new definition
 * refuses (or whose step left the chain) and says so only in its log, so this is how the person
 * who asked for the reseed hears about it.
 */
export function droppedCheckpoints(
  before: { agentKinds: readonly string[]; gates?: readonly boolean[] },
  after: { agentKinds: readonly string[]; gates?: readonly boolean[] },
): string[] {
  const kept = new Set(stepOccurrenceKeys(after.agentKinds).filter((_, i) => after.gates?.[i]))
  return stepOccurrenceKeys(before.agentKinds)
    .map((key, i) => (before.gates?.[i] && !kept.has(key) ? before.agentKinds[i] : undefined))
    .filter((kind): kind is string => kind !== undefined)
}

/**
 * The steps whose checkpoint a reseed kept but whose approver policy it did not: gated with a
 * policy on the row before it, gated on the same step after it, with a different policy. The
 * backend drops a policy the new definition refuses and keeps the checkpoint on the defaults.
 */
export function droppedApproverPolicies(
  before: Pick<Pipeline, 'agentKinds' | 'gates' | 'stepOptions'>,
  after: Pick<Pipeline, 'agentKinds' | 'gates' | 'stepOptions'>,
): string[] {
  const policyAfter = new Map<string, string>()
  stepOccurrenceKeys(after.agentKinds).forEach((key, i) => {
    if (after.gates?.[i])
      policyAfter.set(key, JSON.stringify(approvalPolicyOf(after.stepOptions?.[i])))
  })
  return stepOccurrenceKeys(before.agentKinds)
    .map((key, i) => {
      const policy = approvalPolicyOf(before.stepOptions?.[i])
      if (!before.gates?.[i] || !policy || !policyAfter.has(key)) return undefined
      return policyAfter.get(key) === JSON.stringify(policy) ? undefined : before.agentKinds[i]
    })
    .filter((kind): kind is string => kind !== undefined)
}

/**
 * For each step, whether a checkpoint there could never be reached on some runs, because the step
 * (or the producer a companion reviews) may be skipped by the task estimate or a run condition. The
 * backend refuses such a checkpoint, so the controls do not offer one.
 */
export function unreachableCheckpoints(shape: SkippableStepsShape): boolean[] {
  return shape.agentKinds.map((_, i) => checkpointSkippedBy(shape, i, isProducerCompanion) !== null)
}
