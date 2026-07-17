import type {
  WorkspaceAccessMode,
  WorkspaceMember,
  WorkspaceRole,
  Workspace,
} from '@cat-factory/kernel'
import type {
  GroupCacheHandle,
  MembershipRepository,
  UserRepository,
  WorkspaceAccessCacheValue,
  WorkspaceMemberRecord,
  WorkspaceMemberRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import type { Clock } from '@cat-factory/kernel'
import { NotFoundError, ValidationError, assertFound, requireWorkspace } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// WorkspaceMemberService: the roster + access-mode management for the workspace-RBAC
// tier (workspace-rbac initiative, slice 5). It sits BELOW the account tier — a board
// membership scopes a user to one board within an account they already belong to. The
// only rule beyond the wire validation is that a member MUST first belong to the board's
// owning account (contractors join the account, then get scoped); cross-account grants
// are out of scope.
//
// Every write that changes a resolution outcome (roster add/setRole/remove, access-mode
// flip) drops the board's `workspaceAccess` cache GROUP right after it commits — the
// coherence story is invalidation, not the TTL. The gate resolves through the same slice,
// so a live grant/revocation is visible on the immediately following request.
// ---------------------------------------------------------------------------

export interface WorkspaceMemberServiceDependencies {
  workspaceMemberRepository: WorkspaceMemberRepository
  workspaceRepository: WorkspaceRepository
  /** Enforces the "target must belong to the owning account" rule (account membership is a prerequisite). */
  membershipRepository: MembershipRepository
  clock: Clock
  /** Optional: resolve member display details (name/email/avatar) for the roster. */
  userRepository?: UserRepository
  /**
   * The `workspaceAccess` cache slice. When wired, every roster/access-mode write invalidates the
   * board's group so the gate re-resolves on the next request. Optional — absent (tests / no cache)
   * ⇒ the write skips invalidation (the gate reads live).
   */
  workspaceAccessCache?: GroupCacheHandle<WorkspaceAccessCacheValue>
}

/** Manages a board's explicit member roster and its account/restricted access mode. */
export class WorkspaceMemberService {
  private readonly members: WorkspaceMemberRepository
  private readonly workspaces: WorkspaceRepository
  private readonly memberships: MembershipRepository
  private readonly clock: Clock
  private readonly users?: UserRepository
  private readonly cache?: GroupCacheHandle<WorkspaceAccessCacheValue>

  constructor(deps: WorkspaceMemberServiceDependencies) {
    this.members = deps.workspaceMemberRepository
    this.workspaces = deps.workspaceRepository
    this.memberships = deps.membershipRepository
    this.clock = deps.clock
    this.users = deps.userRepository
    this.cache = deps.workspaceAccessCache
  }

  /**
   * The board's roster, enriched with each member's display details (name/email/avatar) via ONE
   * batched `listByIds` — the {@link AccountService.members} pattern, never a per-member point-read.
   */
  async list(workspaceId: string): Promise<WorkspaceMember[]> {
    const rows = await this.members.listByWorkspace(workspaceId)
    if (!this.users || rows.length === 0) return rows.map(toWire)
    const records = await this.users.listByIds(rows.map((m) => m.userId))
    const byId = new Map(records.map((u) => [u.id, u]))
    return rows.map((m) => {
      const user = byId.get(m.userId)
      return {
        ...toWire(m),
        name: user?.name ?? null,
        email: user?.email ?? null,
        avatarUrl: user?.avatarUrl ?? null,
      }
    })
  }

  /**
   * Add (or re-role, upsert semantics) a member. The target MUST already belong to the board's
   * owning account — a `restricted` board narrows WITHIN an account, it never grants across the
   * account boundary; a non-account-member is a {@link ValidationError}. A legacy board
   * (`account_id IS NULL`) has no account to scope against, so member management is refused there.
   */
  async add(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
    addedByUserId: string | null,
  ): Promise<WorkspaceMember> {
    const accountId = await this.requireOwningAccount(workspaceId)
    if (!(await this.memberships.get(accountId, userId))) {
      throw new ValidationError(
        'A workspace member must first belong to the board’s owning account',
      )
    }
    const record: WorkspaceMemberRecord = {
      workspaceId,
      userId,
      role,
      createdAt: this.clock.now(),
      addedByUserId,
    }
    await this.members.upsert(record)
    await this.invalidate(workspaceId)
    return toWire(record)
  }

  /** Change an existing member's role (404 when they hold no row). Preserves the audit metadata. */
  async setRole(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
  ): Promise<WorkspaceMember> {
    const existing = await this.members.get(workspaceId, userId)
    if (!existing) throw new NotFoundError('Workspace member', userId)
    const record: WorkspaceMemberRecord = { ...existing, role }
    await this.members.upsert(record)
    await this.invalidate(workspaceId)
    return toWire(record)
  }

  /** Remove a member's row. Idempotent (removing an absent row is a no-op). */
  async remove(workspaceId: string, userId: string): Promise<void> {
    await this.members.remove(workspaceId, userId)
    await this.invalidate(workspaceId)
  }

  /**
   * Flip a board's access mode (`account` ⇄ `restricted`). Returns the updated board so the SPA can
   * patch it in place. Requires the board to exist (404 otherwise). Invalidates the access cache —
   * the mode is a direct input to resolution for every user.
   */
  async setAccessMode(workspaceId: string, mode: WorkspaceAccessMode): Promise<Workspace> {
    await requireWorkspace(this.workspaces, workspaceId)
    await this.workspaces.setAccessMode(workspaceId, mode)
    await this.invalidate(workspaceId)
    return requireWorkspace(this.workspaces, workspaceId)
  }

  /** The board's owning account id, or a {@link ValidationError} for a legacy/unscoped board. */
  private async requireOwningAccount(workspaceId: string): Promise<string> {
    const row = assertFound(
      await this.workspaces.accessRowOf(workspaceId),
      'Workspace',
      workspaceId,
    )
    if (row.accountId === null) {
      throw new ValidationError('Member management is not available for a legacy (unscoped) board')
    }
    return row.accountId
  }

  /** Drop the board's cached access decisions after a write commits (no-op when unwired). */
  private async invalidate(workspaceId: string): Promise<void> {
    await this.cache?.invalidateGroup(workspaceId)
  }
}

/** Map a persistence record to its wire shape (audit `addedByUserId` → `addedBy`). */
function toWire(record: WorkspaceMemberRecord): WorkspaceMember {
  return {
    workspaceId: record.workspaceId,
    userId: record.userId,
    role: record.role,
    createdAt: record.createdAt,
    addedBy: record.addedByUserId,
  }
}
