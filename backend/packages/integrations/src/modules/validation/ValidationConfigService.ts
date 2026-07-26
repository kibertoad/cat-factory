import type {
  BlockRepository,
  Clock,
  ValidationConfigRecord,
  ValidationConfigRepository,
} from '@cat-factory/kernel'
import { NotFoundError, resolveServiceFrameBlock, ValidationError } from '@cat-factory/kernel'
import type {
  ResolvedValidationChecks,
  ServiceValidationConfig,
  UpsertServiceValidationConfigInput,
} from '@cat-factory/contracts'
import { VALIDATION_DEFAULT_MAX_ATTEMPTS } from '@cat-factory/contracts'

export interface ValidationConfigServiceDependencies {
  validationConfigRepository: ValidationConfigRepository
  /** Walks a run's block up to its service frame (the checks are keyed by the frame). */
  blockRepository: BlockRepository
  clock: Clock
}

/**
 * Owns a service's PRE-PR VALIDATION CHECKS — the shell commands the executor-harness runs
 * against the checkout after the coding agent settles and BEFORE the PR opens (see
 * `docs/initiatives/pre-pr-validation.md`).
 *
 * The CRUD surface ({@link getView}/{@link set}/{@link deleteFor}) operates on the exact SERVICE
 * FRAME block the inspector edits. The resolution surface ({@link resolveForBlock}) walks a run's
 * task block UP to its service frame — the same `resolveServiceFrameBlock` walk the engine's
 * `AgentContextBuilder` and the sealed test-secret store use — and is the SINGLE seam a dispatch
 * resolves checks through, so adding a second source later (a checked-in repo manifest, see the
 * tracker's D1) is a change inside this method plus a precedence rule, not a new path through the
 * executor.
 *
 * Nothing here is a secret: the commands are operator-authored strings that run inside the run's
 * own sandboxed container, the same trust boundary as the coding agent.
 */
export class ValidationConfigService {
  private readonly repo: ValidationConfigRepository
  private readonly blocks: BlockRepository
  private readonly clock: Clock

  constructor(deps: ValidationConfigServiceDependencies) {
    this.repo = deps.validationConfigRepository
    this.blocks = deps.blockRepository
    this.clock = deps.clock
  }

  /** The checks configured for a service frame (empty when it has none). */
  async getView(workspaceId: string, blockId: string): Promise<ServiceValidationConfig> {
    const record = await this.repo.getByBlock(workspaceId, blockId)
    return toView(blockId, record)
  }

  /** Every configured service's checks in the workspace (the inspector store's hydrate read). */
  async list(workspaceId: string): Promise<ServiceValidationConfig[]> {
    const rows = await this.repo.listByWorkspace(workspaceId)
    return rows.map((r) => toView(r.blockId, r))
  }

  /**
   * Set/replace a service frame's validation checks. An empty list deletes the row (a service
   * with no checks carries none), so a cleared inspector restores the exact pre-feature
   * behaviour rather than leaving an empty config that still has to be resolved.
   */
  async set(
    workspaceId: string,
    blockId: string,
    input: UpsertServiceValidationConfigInput,
  ): Promise<ServiceValidationConfig> {
    // Checks are keyed by (and resolved up to) the SERVICE FRAME, so storing them against a
    // module/task block would leave them silently un-run at dispatch time (resolution walks UP
    // to the frame and never finds them). Reject a non-frame block here so the operator gets a
    // clear error instead of a config that appears to save but never runs.
    const block = await this.blocks.get(workspaceId, blockId)
    if (!block) throw new NotFoundError('block', blockId)
    if (block.level !== 'frame') {
      throw new ValidationError('Validation checks can only be set on a service frame')
    }
    if (input.checks.length === 0) {
      await this.repo.delete(workspaceId, blockId)
      return toView(blockId, null)
    }
    const now = this.clock.now()
    const existing = await this.repo.getByBlock(workspaceId, blockId)
    const record: ValidationConfigRecord = {
      workspaceId,
      blockId,
      checks: input.checks.map((c) => ({ label: c.label, command: c.command })),
      maxAttempts: input.maxAttempts ?? VALIDATION_DEFAULT_MAX_ATTEMPTS,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await this.repo.upsert(record)
    return toView(blockId, record)
  }

  /** Remove a service frame's validation checks. */
  async deleteFor(workspaceId: string, blockId: string): Promise<void> {
    await this.repo.delete(workspaceId, blockId)
  }

  /**
   * The checks that apply to a RUN's block — walked up to its service frame. This is what the
   * engine folds onto the agent run context and the container executor forwards on the coding
   * job body. `null` when the block has no service frame or the frame configured no checks,
   * which is what keeps an unconfigured deployment byte-for-byte on the old code path.
   */
  async resolveForBlock(
    workspaceId: string,
    blockId: string,
  ): Promise<ResolvedValidationChecks | null> {
    const frame = await resolveServiceFrameBlock((id) => this.blocks.get(workspaceId, id), blockId)
    if (!frame) return null
    const record = await this.repo.getByBlock(workspaceId, frame.id)
    if (!record || record.checks.length === 0) return null
    return {
      checks: record.checks.map((c) => ({ label: c.label, command: c.command })),
      maxAttempts: record.maxAttempts,
    }
  }
}

/** Project a stored record (or its absence) into the wire view. */
function toView(blockId: string, record: ValidationConfigRecord | null): ServiceValidationConfig {
  return {
    blockId,
    checks: record?.checks ?? [],
    maxAttempts: record?.maxAttempts ?? VALIDATION_DEFAULT_MAX_ATTEMPTS,
  }
}
