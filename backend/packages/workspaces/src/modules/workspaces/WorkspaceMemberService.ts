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
// Legacy (`account_id IS NULL`) boards are NOT supported as a persistent state: member
// management auto-heals one into an account (`ensureAccountScoped`) rather than refusing it,
// so an operator managing members never hits a dead end — see that method for the adopt rule.
//
// Every write that changes a resolution outcome (roster add/setRole/remove, access-mode
// flip, the auto-heal link) drops the board's `workspaceAccess` cache GROUP right after it
// commits — the coherence story is invalidation, not the TTL. The gate resolves through the
// same slice, so a live grant/revocation is visible on the immediately following request.
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
   * 404s a non-existent board (an empty roster and a missing board must not read the same to the
   * caller).
   */
  async list(workspaceId: string): Promise<WorkspaceMember[]> {
    await requireWorkspace(this.workspaces, workspaceId)
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
   * (`account_id IS NULL`) is auto-healed into an account first ({@link ensureAccountScoped}).
   */
  async add(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
    addedByUserId: string | null,
  ): Promise<WorkspaceMember> {
    const accountId = await this.ensureAccountScoped(workspaceId)
    if (!(await this.memberships.get(accountId, userId))) {
      throw new ValidationError(
        'A workspace member must first belong to the board’s owning account',
      )
    }
    // Upsert preserves the ORIGINAL grant metadata on conflict (both repos `ON CONFLICT DO UPDATE`
    // only `role`), so a re-add of an existing member must return THOSE stored values — never a
    // fresh `createdAt` / `addedBy` the persisted row (and every later read) wouldn't reflect.
    const existing = await this.members.get(workspaceId, userId)
    const record: WorkspaceMemberRecord = existing
      ? { ...existing, role }
      : { workspaceId, userId, role, createdAt: this.clock.now(), addedByUserId }
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
   * patch it in place. Auto-heals a legacy board first ({@link ensureAccountScoped}) — an access
   * mode on an unscoped board is a silent no-op (resolution's legacy branch ignores it), so the
   * flip only means something once the board is account-scoped. Invalidates the access cache — the
   * mode is a direct input to resolution for every user.
   */
  async setAccessMode(workspaceId: string, mode: WorkspaceAccessMode): Promise<Workspace> {
    await this.ensureAccountScoped(workspaceId)
    await this.workspaces.setAccessMode(workspaceId, mode)
    await this.invalidate(workspaceId)
    return requireWorkspace(this.workspaces, workspaceId)
  }

  /**
   * The board's owning account id — auto-healing a legacy (`account_id IS NULL`) board on the way.
   * Member management requires an account: a `restricted` board narrows WITHIN an account, and an
   * unscoped board is invisible to resolution's account tier (only its owner sees it), so a roster
   * / access-mode change on it would silently do nothing. Rather than refuse (the old behaviour) we
   * LINK the board to an account and proceed — "drop support for legacy boards" means heal them.
   *
   * The adopt target is the board OWNER's sole account: on a legacy board the owner is the only
   * principal resolution lets reach member management (the account-admin escape hatch does not
   * apply to the `account_id IS NULL` branch), so the caller here IS the owner. Ambiguous — no
   * owner, or the owner belongs to several accounts — throws a {@link ValidationError} telling the
   * caller to link the board explicitly (auto-heal never guesses which account to expose a board
   * to). On heal we also (re)assert the owner's `admin` member row so a follow-up flip to
   * `restricted` can't lock the owner out, mirroring the creator auto-enroll in `WorkspaceService`.
   */
  private async ensureAccountScoped(workspaceId: string): Promise<string> {
    const row = assertFound(
      await this.workspaces.accessRowOf(workspaceId),
      'Workspace',
      workspaceId,
    )
    if (row.accountId !== null) return row.accountId
    const { ownerUserId } = row
    if (!ownerUserId) {
      throw new ValidationError(
        'This board is not linked to an account and has no owner to link it through — assign it to an account first',
      )
    }
    const accounts = await this.memberships.listByUser(ownerUserId)
    if (accounts.length !== 1) {
      throw new ValidationError(
        'This board is not linked to an account — link it to one of its owner’s accounts to manage members',
      )
    }
    const accountId = accounts[0]!.accountId
    await this.workspaces.linkAccount(workspaceId, accountId)
    // Keep the owner in admin control post-heal (a restricted board reads member rows only). System
    // grant ⇒ `addedByUserId: null`; upsert preserves an existing row's audit metadata.
    await this.members.upsert({
      workspaceId,
      userId: ownerUserId,
      role: 'admin',
      createdAt: this.clock.now(),
      addedByUserId: null,
    })
    await this.invalidate(workspaceId)
    return accountId
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
