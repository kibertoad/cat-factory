import type {
  Clock,
  ConsensusGroup,
  ConsensusGroupRepository,
  CreateConsensusGroupInput,
  IdGenerator,
  UpdateConsensusGroupInput,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { assertFound, requireWorkspace, ValidationError } from '@cat-factory/kernel'

export interface ConsensusGroupServiceDependencies {
  consensusGroupRepository: ConsensusGroupRepository
  workspaceRepository: WorkspaceRepository
  idGenerator: IdGenerator
  clock: Clock
}

/** The gating a group gets when the author supplies none: the unconditional floor tier. */
const UNGATED: ConsensusGroup['gating'] = { enabled: false, onMissingEstimate: 'consensus' }

/**
 * CRUD over a workspace's consensus-GROUP library — the reusable, estimate-gated panels a
 * pipeline step escalates to. A group is a named set of participants plus the strategy that
 * runs them and the estimate bar a task must clear to earn it; a step names a SET of groups and
 * the engine picks the most demanding one the task clears (`selectConsensusGroup`).
 *
 * Unlike the model-preset library there is no seeding and no default: a workspace that has
 * authored no group simply has no tiers to escalate to, and every consensus step falls back to
 * its inline participants exactly as before. The feature is additive by construction.
 */
export class ConsensusGroupService {
  private readonly groups: ConsensusGroupRepository
  private readonly workspaceRepository: WorkspaceRepository
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock

  constructor(deps: ConsensusGroupServiceDependencies) {
    this.groups = deps.consensusGroupRepository
    this.workspaceRepository = deps.workspaceRepository
    this.idGenerator = deps.idGenerator
    this.clock = deps.clock
  }

  /** The workspace's library (settings editor + the board-load snapshot). */
  async list(workspaceId: string): Promise<ConsensusGroup[]> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    return this.groups.list(workspaceId)
  }

  async create(workspaceId: string, input: CreateConsensusGroupInput): Promise<ConsensusGroup> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const group: ConsensusGroup = {
      id: this.idGenerator.next('cng'),
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      strategy: input.strategy,
      participants: withParticipantIds(input.participants, this.idGenerator),
      ...(input.synthesizerModelId ? { synthesizerModelId: input.synthesizerModelId } : {}),
      ...(input.rounds !== undefined ? { rounds: input.rounds } : {}),
      gating: assertUsableGating(input.gating ?? UNGATED),
      createdAt: this.clock.now(),
    }
    await this.groups.upsert(workspaceId, group)
    return group
  }

  async update(
    workspaceId: string,
    id: string,
    patch: UpdateConsensusGroupInput,
  ): Promise<ConsensusGroup> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const existing = assertFound(await this.groups.get(workspaceId, id), 'ConsensusGroup', id)
    const updated: ConsensusGroup = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.strategy !== undefined ? { strategy: patch.strategy } : {}),
      ...(patch.participants !== undefined
        ? { participants: withParticipantIds(patch.participants, this.idGenerator) }
        : {}),
      ...(patch.synthesizerModelId !== undefined
        ? { synthesizerModelId: patch.synthesizerModelId }
        : {}),
      ...(patch.rounds !== undefined ? { rounds: patch.rounds } : {}),
      ...(patch.gating !== undefined ? { gating: assertUsableGating(patch.gating) } : {}),
    }
    await this.groups.upsert(workspaceId, updated)
    return updated
  }

  /**
   * Delete a group. A pipeline step still naming it is deliberately NOT rewritten: the step's
   * tier set degrades to its remaining groups on the next dispatch (`listByIds` simply omits
   * what no longer resolves), which is the same disposition a step gets when a tier's bar is
   * not cleared. Cascading the delete into every pipeline would be a write across the whole
   * library to express what the read already expresses.
   */
  async remove(workspaceId: string, id: string): Promise<void> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    await this.groups.remove(workspaceId, id)
  }
}

/**
 * Refuse a gating block that enables gating but names no threshold. Such a group can never be
 * selected on score, so it would sit in a step's tier set doing nothing while reading as an
 * active tier — the failure mode that is invisible until someone asks why the panel never ran.
 * The way to express "always applies" is `enabled: false`, which this leaves alone.
 */
function assertUsableGating(gating: ConsensusGroup['gating']): ConsensusGroup['gating'] {
  if (!gating.enabled) return gating
  const named = [gating.minComplexity, gating.minRisk, gating.minImpact].some(
    (t) => t !== undefined,
  )
  if (!named) {
    throw new ValidationError(
      'A gated consensus group must set at least one estimate threshold (complexity, risk or impact). Disable gating to make the group apply to every task.',
      { reason: 'consensus_group_gating_without_threshold' },
    )
  }
  return gating
}

/**
 * Give every participant a stable id. The editor sends role/framing/model rows; the id is what
 * the session transcript keys contributions on, so it must survive an edit that only reorders
 * or renames — an author-supplied one is kept, and only a blank one is minted.
 */
function withParticipantIds(
  participants: ConsensusGroup['participants'],
  idGenerator: IdGenerator,
): ConsensusGroup['participants'] {
  return participants.map((p) => ({ ...p, id: p.id || idGenerator.next('cnp') }))
}
