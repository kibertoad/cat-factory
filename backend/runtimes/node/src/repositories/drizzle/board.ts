// Drizzle/Postgres implementations of the core kernel repository ports, split by
// domain (mirrors the Cloudflare D1 per-repository layout). The row<->domain mapping
// is the SAME shared mapping the D1 repos use (@cat-factory/server), so behaviour
// matches across stores; this layer only owns the Drizzle queries. Assembled into the
// CoreRepositories set by ./drizzle.ts (the barrel).

import type {
  Block,
  BlockPatch,
  BlockRepository,
  BlockStatus,
  Service,
  ServiceFragmentDefaultsRepository,
  ServicePatch,
  MountRehome,
  ServiceRepository,
  Workspace,
  WorkspaceAccessMode,
  WorkspaceAccessRow,
  WorkspaceMemberRecord,
  WorkspaceMemberRepository,
  WorkspaceMount,
  WorkspaceMountPatch,
  WorkspaceMountRepository,
  WorkspaceRepository,
  WorkspaceRole,
  WorkspaceVisibility,
} from '@cat-factory/kernel'
import { WORKSPACE_SCOPED_TABLES } from '@cat-factory/kernel'
import { decodeMountSubjectKind } from '@cat-factory/contracts'
import {
  blockCompletionStamp,
  blockInsertValues,
  blockPatchToColumns,
  rowToBlock,
  rowToWorkspace,
  tryDecodeRows,
} from '@cat-factory/server'
import { and, count, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import {
  accountSource,
  accountWorkspaceMembershipsSource,
  appendDirectoryChanges,
  lockDirectoryFeed,
  workspaceMembershipSource,
  workspaceMoveSource,
  workspaceSource,
  workspaceTreeSource,
} from '../directoryFeed.js'
import {
  agentRuns,
  blocks,
  findingsRevisions,
  findingsStoragePolicies,
  projectServiceLinks,
  researchProjects,
  researchTaskSeqs,
  projects,
  services,
  workspaceFragmentDefaults,
  workspaceMembers,
  workspaceMounts,
  workspaces,
} from '../../db/schema.js'

export class DrizzleWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listVisible(scope: WorkspaceVisibility): Promise<Workspace[]> {
    if (scope === null) {
      const rows = await this.db.select().from(workspaces).orderBy(desc(workspaces.created_at))
      return rows.map(rowToWorkspace)
    }
    // Resolved SQL-side (see WorkspaceVisibility): unrestricted boards in accounts the user
    // belongs to, ANY board in accounts they admin (escape hatch), boards they hold an
    // explicit member row on (ANDed with their account ids so an orphaned foreign-account
    // row can't resurface), and legacy boards they personally own.
    const predicates = [
      and(isNull(workspaces.account_id), eq(workspaces.owner_user_id, scope.ownerUserId)),
    ]
    if (scope.accountIds.length > 0) {
      predicates.push(
        and(
          inArray(workspaces.account_id, scope.accountIds),
          eq(workspaces.access_mode, 'account'),
        ),
      )
      predicates.push(
        and(
          inArray(workspaces.account_id, scope.accountIds),
          inArray(
            workspaces.id,
            this.db
              .select({ id: workspaceMembers.workspace_id })
              .from(workspaceMembers)
              .where(eq(workspaceMembers.user_id, scope.userId)),
          ),
        ),
      )
    }
    if (scope.adminAccountIds.length > 0) {
      predicates.push(inArray(workspaces.account_id, scope.adminAccountIds))
    }
    const rows = await this.db
      .select()
      .from(workspaces)
      .where(or(...predicates))
      .orderBy(desc(workspaces.created_at))
    return rows.map(rowToWorkspace)
  }

  async listByAccount(accountId: string): Promise<Workspace[]> {
    const rows = await this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.account_id, accountId))
      .orderBy(desc(workspaces.created_at))
    return rows.map(rowToWorkspace)
  }

  async get(id: string): Promise<Workspace | null> {
    const [row] = await this.db.select().from(workspaces).where(eq(workspaces.id, id))
    return row ? rowToWorkspace(row) : null
  }

  async ownerOf(id: string): Promise<string | null | undefined> {
    const [row] = await this.db
      .select({ owner: workspaces.owner_user_id })
      .from(workspaces)
      .where(eq(workspaces.id, id))
    return row ? row.owner : undefined
  }

  async accountOf(id: string): Promise<string | null | undefined> {
    const [row] = await this.db
      .select({ account: workspaces.account_id })
      .from(workspaces)
      .where(eq(workspaces.id, id))
    return row ? row.account : undefined
  }

  async accountIdsOf(ids: string[]): Promise<Record<string, string | null>> {
    const found: Record<string, string | null> = {}
    if (ids.length === 0) return found
    const unique = [...new Set(ids)]
    // Chunked to match the D1 twin's parameter ceiling, so both stores issue the same shape of
    // query for the same input rather than one of them degrading on a long list.
    for (let i = 0; i < unique.length; i += 90) {
      const rows = await this.db
        .select({ id: workspaces.id, account: workspaces.account_id })
        .from(workspaces)
        .where(inArray(workspaces.id, unique.slice(i, i + 90)))
      for (const row of rows) found[row.id] = row.account
    }
    return found
  }

  async accessRowOf(id: string): Promise<WorkspaceAccessRow | undefined> {
    const [row] = await this.db
      .select({
        account: workspaces.account_id,
        owner: workspaces.owner_user_id,
        mode: workspaces.access_mode,
      })
      .from(workspaces)
      .where(eq(workspaces.id, id))
    if (!row) return undefined
    return {
      accountId: row.account,
      ownerUserId: row.owner,
      accessMode: row.mode === 'restricted' ? 'restricted' : 'account',
    }
  }

  async setAccessMode(id: string, mode: WorkspaceAccessMode): Promise<void> {
    await this.db.transaction(async (tx) => {
      await lockDirectoryFeed(tx, workspaceSource(id))
      await tx.update(workspaces).set({ access_mode: mode }).where(eq(workspaces.id, id))
      await appendDirectoryChanges(tx, workspaceSource(id), Date.now())
    })
  }

  async linkAccount(id: string, accountId: string): Promise<void> {
    // The board, its members and its repos leave the old account (if it had one) and appear in
    // the new one, so both feeds record the whole tree: before the move and after it.
    await this.db.transaction(async (tx) => {
      const at = Date.now()
      await lockDirectoryFeed(tx, workspaceMoveSource(id, accountId))
      await appendDirectoryChanges(tx, workspaceTreeSource(id), at)
      await tx.update(workspaces).set({ account_id: accountId }).where(eq(workspaces.id, id))
      await appendDirectoryChanges(tx, workspaceTreeSource(id), at)
    })
  }

  async create(
    workspace: Workspace,
    ownerUserId: string | null,
    accountId: string | null,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await lockDirectoryFeed(tx, accountSource(accountId))
      await tx.insert(workspaces).values({
        id: workspace.id,
        name: workspace.name,
        description: workspace.description,
        created_at: workspace.createdAt,
        owner_user_id: ownerUserId,
        account_id: accountId,
      })
      await appendDirectoryChanges(tx, workspaceSource(workspace.id), Date.now())
    })
  }

  async rename(id: string, name: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await lockDirectoryFeed(tx, workspaceSource(id))
      await tx.update(workspaces).set({ name }).where(eq(workspaces.id, id))
      await appendDirectoryChanges(tx, workspaceSource(id), Date.now())
    })
  }

  async setDescription(id: string, description: string | null): Promise<void> {
    await this.db.transaction(async (tx) => {
      await lockDirectoryFeed(tx, workspaceSource(id))
      await tx.update(workspaces).set({ description }).where(eq(workspaces.id, id))
      await appendDirectoryChanges(tx, workspaceSource(id), Date.now())
    })
  }

  async delete(id: string, rehome: MountRehome[] = []): Promise<void> {
    await this.db.transaction(async (tx) => {
      // The directory feed records the board and every member and repo row the cascade below
      // removes, while they still exist to be selected. `directory_changes` itself is kept.
      await appendDirectoryChanges(tx, workspaceTreeSource(id), Date.now())
      // Re-home shared services FIRST: move each service's blocks + run history to a surviving
      // mounting board by re-stamping their `workspace_id`. Blocks are keyed by `owner_id`, so
      // after the move the service's frame no longer lives in THIS workspace — the reclaim below
      // then skips it, leaving the service, its subtree and every OTHER board's mount intact. A
      // shared service therefore outlives its home board's deletion. Mirror any change in the
      // Cloudflare facade's D1WorkspaceRepository.delete.
      for (const { subjectId, toWorkspaceId } of rehome) {
        await tx
          .update(agentRuns)
          .set({ workspace_id: toWorkspaceId })
          .where(
            inArray(
              agentRuns.block_id,
              tx.select({ id: blocks.id }).from(blocks).where(eq(blocks.owner_id, subjectId)),
            ),
          )
        await tx
          .update(blocks)
          .set({ workspace_id: toWorkspaceId })
          .where(eq(blocks.owner_id, subjectId))
      }
      // Reclaim the account-owned services this workspace HOMES (+ every board's mount of them)
      // BEFORE the blocks they reference are dropped. A deleted board that leaves its services
      // behind is not a cosmetic leak: `services` is account-scoped and looked up by
      // (installation_id, repo_github_id), so a dangling service (its frame block gone) keeps the
      // SAME repo from being re-added on any other board in the account. Mirror any change in the
      // Cloudflare facade's D1WorkspaceRepository.delete.
      const homed = await tx
        .select({ id: services.id })
        .from(services)
        .innerJoin(blocks, eq(services.frame_block_id, blocks.id))
        .where(eq(blocks.workspace_id, id))
      const serviceIds = homed.map((r) => r.id)
      if (serviceIds.length) {
        await tx.delete(workspaceMounts).where(inArray(workspaceMounts.subject_id, serviceIds))
        await tx.delete(services).where(inArray(services.id, serviceIds))
      }
      // The same for the projects this workspace homes (their root block lives here, in the
      // board's own account), then links from surviving projects to the services just reclaimed.
      const homedProjects = await tx
        .select({ id: projects.id })
        .from(projects)
        .innerJoin(blocks, eq(projects.root_block_id, blocks.id))
        .where(
          and(
            eq(blocks.workspace_id, id),
            sql`${projects.account_id} IS NOT DISTINCT FROM (SELECT ${workspaces.account_id} FROM ${workspaces} WHERE ${workspaces.id} = ${id})`,
          ),
        )
      const projectIds = homedProjects.map((r) => r.id)
      if (projectIds.length) {
        await tx
          .delete(workspaceMounts)
          .where(
            and(
              eq(workspaceMounts.subject_kind, 'project'),
              inArray(workspaceMounts.subject_id, projectIds),
            ),
          )
        await tx
          .delete(projectServiceLinks)
          .where(inArray(projectServiceLinks.project_id, projectIds))
        // A homed research project's findings, pinned definition and policy tier.
        await tx.delete(findingsRevisions).where(inArray(findingsRevisions.project_id, projectIds))
        await tx.delete(researchTaskSeqs).where(inArray(researchTaskSeqs.project_id, projectIds))
        await tx
          .delete(findingsStoragePolicies)
          .where(
            and(
              eq(findingsStoragePolicies.owner_kind, 'project'),
              inArray(findingsStoragePolicies.owner_id, projectIds),
            ),
          )
        await tx.delete(researchProjects).where(inArray(researchProjects.project_id, projectIds))
        await tx.delete(projects).where(inArray(projects.id, projectIds))
      }
      if (serviceIds.length) {
        await tx
          .delete(projectServiceLinks)
          .where(inArray(projectServiceLinks.service_id, serviceIds))
      }
      // This board's own findings-storage policy tier.
      await tx
        .delete(findingsStoragePolicies)
        .where(
          and(
            eq(findingsStoragePolicies.owner_kind, 'workspace'),
            eq(findingsStoragePolicies.owner_id, id),
          ),
        )
      // This workspace's OWN mounts of subjects homed elsewhere (shared services and projects).
      await tx.delete(workspaceMounts).where(eq(workspaceMounts.workspace_id, id))
      // Bulk reclaim of every plain workspace-scoped table (incl. blocks/agent_runs/pipelines/
      // environments) from the shared kernel list — keeps this cascade in lockstep with the
      // Cloudflare facade and stops a new workspace-scoped table silently orphaning. The schema
      // declares no FKs between these tables, so order is free; they only need to run AFTER the
      // `services` reclaim above (which reads `blocks`) and BEFORE the root `workspaces` row.
      for (const table of WORKSPACE_SCOPED_TABLES) {
        await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE workspace_id = ${id}`)
      }
      await tx.delete(workspaces).where(eq(workspaces.id, id))
    })
  }
}

/** Coerce a stored role string to a valid {@link WorkspaceRole}, defaulting to viewer. */
function parseWorkspaceRole(role: string): WorkspaceRole {
  return role === 'admin' || role === 'member' || role === 'viewer' ? role : 'viewer'
}

function rowToWorkspaceMember(row: typeof workspaceMembers.$inferSelect): WorkspaceMemberRecord {
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: parseWorkspaceRole(row.role),
    createdAt: row.created_at,
    addedByUserId: row.added_by_user_id,
  }
}

/** Drizzle/Postgres store of workspace memberships (workspace RBAC; migration 0052). */
export class DrizzleWorkspaceMemberRepository implements WorkspaceMemberRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string, userId: string): Promise<WorkspaceMemberRecord | null> {
    const [row] = await this.db
      .select()
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspace_id, workspaceId), eq(workspaceMembers.user_id, userId)),
      )
    return row ? rowToWorkspaceMember(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<WorkspaceMemberRecord[]> {
    const rows = await this.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspace_id, workspaceId))
      .orderBy(workspaceMembers.created_at)
    return rows.map(rowToWorkspaceMember)
  }

  async listWorkspaceIdsForUser(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: workspaceMembers.workspace_id })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.user_id, userId))
    return rows.map((r) => r.id)
  }

  async getRolesForUserInWorkspaces(
    userId: string,
    workspaceIds: string[],
  ): Promise<Record<string, WorkspaceRole>> {
    const out: Record<string, WorkspaceRole> = {}
    if (workspaceIds.length === 0) return out
    // ONE chunked-IN read per chunk (never a per-board point-read loop).
    for (let i = 0; i < workspaceIds.length; i += 500) {
      const rows = await this.db
        .select({ id: workspaceMembers.workspace_id, role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.user_id, userId),
            inArray(workspaceMembers.workspace_id, workspaceIds.slice(i, i + 500)),
          ),
        )
      for (const r of rows) out[r.id] = parseWorkspaceRole(r.role)
    }
    return out
  }

  async upsert(member: WorkspaceMemberRecord): Promise<void> {
    await this.db.transaction(async (tx) => {
      await lockDirectoryFeed(tx, workspaceMembershipSource(member.workspaceId, member.userId))
      await tx
        .insert(workspaceMembers)
        .values({
          workspace_id: member.workspaceId,
          user_id: member.userId,
          role: member.role,
          created_at: member.createdAt,
          added_by_user_id: member.addedByUserId,
        })
        .onConflictDoUpdate({
          target: [workspaceMembers.workspace_id, workspaceMembers.user_id],
          set: { role: member.role },
        })
      await appendDirectoryChanges(
        tx,
        workspaceMembershipSource(member.workspaceId, member.userId),
        Date.now(),
      )
    })
  }

  async remove(workspaceId: string, userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await appendDirectoryChanges(tx, workspaceMembershipSource(workspaceId, userId), Date.now())
      await tx
        .delete(workspaceMembers)
        .where(
          and(eq(workspaceMembers.workspace_id, workspaceId), eq(workspaceMembers.user_id, userId)),
        )
    })
  }

  async removeByAccountMembership(accountId: string, userId: string): Promise<number> {
    // One DELETE scoped to the owning account's boards (Postgres has no cross-table DELETE
    // without USING, so filter workspace_id by the account's workspaces subquery). The feed rows
    // are appended first, while the memberships they name still exist to be selected.
    return await this.db.transaction(async (tx) => {
      await appendDirectoryChanges(
        tx,
        accountWorkspaceMembershipsSource(accountId, userId),
        Date.now(),
      )
      const result = await tx
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.user_id, userId),
            inArray(
              workspaceMembers.workspace_id,
              tx
                .select({ id: workspaces.id })
                .from(workspaces)
                .where(eq(workspaces.account_id, accountId)),
            ),
          ),
        )
      return result.rowCount ?? 0
    })
  }
}

export class DrizzleBlockRepository implements BlockRepository {
  constructor(private readonly db: DrizzleDb) {}

  // List reads order by `seq` (insertion order) for parity with the Cloudflare facade's
  // `ORDER BY rowid` — Postgres heap order is otherwise non-deterministic.
  async listByWorkspace(workspaceId: string): Promise<Block[]> {
    const rows = await this.db
      .select()
      .from(blocks)
      .where(eq(blocks.workspace_id, workspaceId))
      .orderBy(blocks.seq)
    // Snapshot-facing list read: drop a corrupt block rather than failing the whole board load.
    return tryDecodeRows(rows, rowToBlock, (r) => ({ table: 'blocks', id: r.id }))
  }

  async listByOwners(ownerIds: string[]): Promise<Block[]> {
    if (ownerIds.length === 0) return []
    const out: Block[] = []
    // Chunk the IN list to stay well under the bind-parameter limit. Ordering is
    // per-chunk, matching the D1 twin's per-chunk `ORDER BY rowid`.
    for (let i = 0; i < ownerIds.length; i += 500) {
      const rows = await this.db
        .select()
        .from(blocks)
        .where(inArray(blocks.owner_id, ownerIds.slice(i, i + 500)))
        .orderBy(blocks.seq)
      out.push(...tryDecodeRows(rows, rowToBlock, (r) => ({ table: 'blocks', id: r.id })))
    }
    return out
  }

  async get(workspaceId: string, id: string): Promise<Block | null> {
    const [row] = await this.db
      .select()
      .from(blocks)
      .where(and(eq(blocks.workspace_id, workspaceId), eq(blocks.id, id)))
    return row ? rowToBlock(row) : null
  }

  async getByExecution(workspaceId: string, executionId: string): Promise<Block | null> {
    const [row] = await this.db
      .select()
      .from(blocks)
      .where(and(eq(blocks.workspace_id, workspaceId), eq(blocks.execution_id, executionId)))
      .limit(1)
    return row ? rowToBlock(row) : null
  }

  async findById(
    blockId: string,
  ): Promise<{ workspaceId: string; ownerId: string | null; block: Block } | null> {
    const [row] = await this.db.select().from(blocks).where(eq(blocks.id, blockId)).limit(1)
    if (!row) return null
    return {
      workspaceId: row.workspace_id,
      ownerId: row.owner_id ?? null,
      block: rowToBlock(row),
    }
  }

  async findByIds(
    blockIds: string[],
  ): Promise<Array<{ workspaceId: string; ownerId: string | null; block: Block }>> {
    if (blockIds.length === 0) return []
    const out: Array<{ workspaceId: string; ownerId: string | null; block: Block }> = []
    // Chunk the IN list to stay well under the bind-parameter limit.
    for (let i = 0; i < blockIds.length; i += 500) {
      const rows = await this.db
        .select()
        .from(blocks)
        .where(inArray(blocks.id, blockIds.slice(i, i + 500)))
      out.push(
        ...rows.map((row) => ({
          workspaceId: row.workspace_id,
          ownerId: row.owner_id ?? null,
          block: rowToBlock(row),
        })),
      )
    }
    return out
  }

  async insert(workspaceId: string, block: Block, ownerId?: string | null): Promise<void> {
    await this.db.insert(blocks).values({
      workspace_id: workspaceId,
      owner_id: ownerId ?? null,
      ...blockInsertValues(block),
    } as typeof blocks.$inferInsert)
  }

  async update(workspaceId: string, id: string, patch: BlockPatch): Promise<void> {
    const set: Record<string, unknown> = blockPatchToColumns(patch)

    // `completed_at` is derived here rather than at the call sites that mark a task done
    // (see `blockCompletionStamp`). `COALESCE` against the column itself is what makes the
    // stamp first-write-wins against a replaying durable driver: Postgres evaluates the
    // right-hand side against the row's PRE-update value, so a second `done` write keeps
    // the original date.
    const stamp = blockCompletionStamp(patch, Date.now())
    if (stamp.kind === 'stampIfUnset') {
      set.completed_at = sql`COALESCE(${blocks.completed_at}, ${stamp.at})`
    } else if (stamp.kind === 'clear') {
      set.completed_at = null
    }

    if (Object.keys(set).length === 0) return
    await this.db
      .update(blocks)
      .set(set as Partial<typeof blocks.$inferInsert>)
      .where(and(eq(blocks.workspace_id, workspaceId), eq(blocks.id, id)))
  }

  async setOwner(workspaceId: string, ids: string[], ownerId: string | null): Promise<void> {
    if (ids.length === 0) return
    await this.db
      .update(blocks)
      .set({ owner_id: ownerId })
      .where(and(eq(blocks.workspace_id, workspaceId), inArray(blocks.id, ids)))
  }

  async shiftChildPositions(
    workspaceId: string,
    parentId: string,
    dx: number,
    dy: number,
  ): Promise<void> {
    if (dx === 0 && dy === 0) return
    await this.db
      .update(blocks)
      .set({
        pos_x: sql`${blocks.pos_x} + ${dx}`,
        pos_y: sql`${blocks.pos_y} + ${dy}`,
      })
      .where(and(eq(blocks.workspace_id, workspaceId), eq(blocks.parent_id, parentId)))
  }

  async deleteMany(workspaceId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await this.db
      .delete(blocks)
      .where(and(eq(blocks.workspace_id, workspaceId), inArray(blocks.id, ids)))
  }

  async countActiveInternal(workspaceId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(blocks)
      .where(
        and(
          eq(blocks.workspace_id, workspaceId),
          eq(blocks.internal, 1),
          eq(blocks.status, 'in_progress'),
        ),
      )
    return row?.n ?? 0
  }

  async listServiceTasks(
    workspaceId: string,
    frameId: string,
    opts: { limit: number; afterId?: string; status?: BlockStatus },
  ): Promise<Block[]> {
    // A `task` may only hang off a `frame` or a `module`, so "parented by the frame, or by a
    // module of the frame" covers the whole task subtree — no recursion needed. The module leg is
    // a subquery rather than a bound id list, mirroring the D1 repo (same predicates, same `id`
    // ordering) — see its comment for why the id list is not an option there.
    const moduleIds = this.db
      .select({ id: blocks.id })
      .from(blocks)
      .where(
        and(
          eq(blocks.workspace_id, workspaceId),
          eq(blocks.parent_id, frameId),
          eq(blocks.level, 'module'),
        ),
      )
    const filters = [
      eq(blocks.workspace_id, workspaceId),
      or(eq(blocks.parent_id, frameId), inArray(blocks.parent_id, moduleIds))!,
      eq(blocks.level, 'task'),
      // `internal` is a nullable flag: an ordinary block stores NULL, an anchor stores 1.
      or(isNull(blocks.internal), eq(blocks.internal, 0))!,
    ]
    if (opts.status) filters.push(eq(blocks.status, opts.status))
    if (opts.afterId) filters.push(gt(blocks.id, opts.afterId))
    const rows = await this.db
      .select()
      .from(blocks)
      .where(and(...filters))
      .orderBy(blocks.id)
      .limit(opts.limit)
    return tryDecodeRows(rows, rowToBlock, (r) => ({ table: 'blocks', id: r.id }))
  }
}

export class DrizzleServiceFragmentDefaultsRepository implements ServiceFragmentDefaultsRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string): Promise<string[]> {
    const [row] = await this.db
      .select({ fragmentIds: workspaceFragmentDefaults.fragment_ids })
      .from(workspaceFragmentDefaults)
      .where(eq(workspaceFragmentDefaults.workspace_id, workspaceId))
    return row ? (JSON.parse(row.fragmentIds) as string[]) : []
  }

  async set(workspaceId: string, fragmentIds: string[]): Promise<void> {
    await this.db
      .insert(workspaceFragmentDefaults)
      .values({
        workspace_id: workspaceId,
        fragment_ids: JSON.stringify(fragmentIds),
        updated_at: Date.now(),
      })
      .onConflictDoUpdate({
        target: workspaceFragmentDefaults.workspace_id,
        set: { fragment_ids: JSON.stringify(fragmentIds), updated_at: Date.now() },
      })
  }
}

function rowToService(row: typeof services.$inferSelect): Service {
  return {
    id: row.id,
    accountId: row.account_id,
    frameBlockId: row.frame_block_id,
    installationId: row.installation_id,
    repoGithubId: row.repo_github_id,
    directory: row.directory,
    createdAt: row.created_at,
  }
}

/** Account-owned services (migration 0030). The canonical, shareable board unit. */

export class DrizzleServiceRepository implements ServiceRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(id: string): Promise<Service | null> {
    const [row] = await this.db.select().from(services).where(eq(services.id, id))
    return row ? rowToService(row) : null
  }

  async getByFrameBlock(frameBlockId: string): Promise<Service | null> {
    const [row] = await this.db
      .select()
      .from(services)
      .where(eq(services.frame_block_id, frameBlockId))
    return row ? rowToService(row) : null
  }

  async listByFrameBlocks(frameBlockIds: string[]): Promise<Service[]> {
    if (frameBlockIds.length === 0) return []
    const out: Service[] = []
    // Chunk the IN list to stay well under the bind-parameter limit.
    for (let i = 0; i < frameBlockIds.length; i += 500) {
      const rows = await this.db
        .select()
        .from(services)
        .where(inArray(services.frame_block_id, frameBlockIds.slice(i, i + 500)))
      for (const row of rows) out.push(rowToService(row))
    }
    return out
  }

  async listByAccount(accountId: string | null): Promise<Service[]> {
    // NULL-safe match so the legacy/unscoped org (accountId null) lists cleanly.
    const rows = await this.db
      .select()
      .from(services)
      .where(sql`${services.account_id} IS NOT DISTINCT FROM ${accountId}`)
      .orderBy(services.created_at)
    return rows.map(rowToService)
  }

  async listByIds(ids: string[]): Promise<Service[]> {
    if (ids.length === 0) return []
    const out: Service[] = []
    // Chunk the IN list to stay well under the bind-parameter limit.
    for (let i = 0; i < ids.length; i += 500) {
      const rows = await this.db
        .select()
        .from(services)
        .where(inArray(services.id, ids.slice(i, i + 500)))
      for (const row of rows) out.push(rowToService(row))
    }
    return out
  }

  async insert(service: Service): Promise<void> {
    await this.db.insert(services).values({
      id: service.id,
      account_id: service.accountId,
      frame_block_id: service.frameBlockId,
      installation_id: service.installationId,
      repo_github_id: service.repoGithubId,
      directory: service.directory ?? null,
      created_at: service.createdAt,
    })
  }

  async update(id: string, patch: ServicePatch): Promise<void> {
    const set: Record<string, unknown> = {}
    if ('accountId' in patch) set.account_id = patch.accountId ?? null
    if ('installationId' in patch) set.installation_id = patch.installationId ?? null
    if ('repoGithubId' in patch) set.repo_github_id = patch.repoGithubId ?? null
    if ('directory' in patch) set.directory = patch.directory ?? null
    if (Object.keys(set).length === 0) return
    await this.db.update(services).set(set).where(eq(services.id, id))
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(services).where(eq(services.id, id))
  }

  async deleteMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    // Chunk the IN list to stay well under the bind-parameter limit.
    for (let i = 0; i < ids.length; i += 500) {
      await this.db.delete(services).where(inArray(services.id, ids.slice(i, i + 500)))
    }
  }
}

function rowToMount(row: typeof workspaceMounts.$inferSelect): WorkspaceMount {
  return {
    workspaceId: row.workspace_id,
    subjectKind: decodeMountSubjectKind(row.subject_kind),
    subjectId: row.subject_id,
    position: { x: row.pos_x, y: row.pos_y },
    size: row.width !== null && row.height !== null ? { w: row.width, h: row.height } : null,
    createdAt: row.created_at,
  }
}

/** A service mounted onto a workspace board + its per-workspace layout (migration 0030). */

export class DrizzleWorkspaceMountRepository implements WorkspaceMountRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByWorkspace(workspaceId: string): Promise<WorkspaceMount[]> {
    const rows = await this.db
      .select()
      .from(workspaceMounts)
      .where(eq(workspaceMounts.workspace_id, workspaceId))
      .orderBy(workspaceMounts.created_at)
    return rows.map(rowToMount)
  }

  async listBySubjectIds(subjectIds: string[]): Promise<WorkspaceMount[]> {
    if (subjectIds.length === 0) return []
    const rows = await this.db
      .select()
      .from(workspaceMounts)
      .where(inArray(workspaceMounts.subject_id, subjectIds))
      .orderBy(workspaceMounts.created_at)
    return rows.map(rowToMount)
  }

  async listWorkspaceIdsMountingBlock(
    originWorkspaceId: string,
    blockId: string,
  ): Promise<string[]> {
    // One join: the subject owning the block, then the workspaces that mount it. A block with no
    // owner makes the subquery NULL, which matches no rows (`subject_id = NULL`), so it is empty.
    const rows = await this.db
      .select({ workspaceId: workspaceMounts.workspace_id })
      .from(workspaceMounts)
      .where(
        sql`${workspaceMounts.subject_id} = (SELECT ${blocks.owner_id} FROM ${blocks} WHERE ${blocks.workspace_id} = ${originWorkspaceId} AND ${blocks.id} = ${blockId})`,
      )
    return rows.map((r) => r.workspaceId)
  }

  async countBySubjectIds(subjectIds: string[]): Promise<Record<string, number>> {
    if (subjectIds.length === 0) return {}
    const rows = await this.db
      .select({ subjectId: workspaceMounts.subject_id, n: sql<number>`count(*)` })
      .from(workspaceMounts)
      .where(inArray(workspaceMounts.subject_id, subjectIds))
      .groupBy(workspaceMounts.subject_id)
    const counts: Record<string, number> = {}
    for (const row of rows) counts[row.subjectId] = Number(row.n)
    return counts
  }

  async get(workspaceId: string, subjectId: string): Promise<WorkspaceMount | null> {
    const [row] = await this.db
      .select()
      .from(workspaceMounts)
      .where(
        and(
          eq(workspaceMounts.workspace_id, workspaceId),
          eq(workspaceMounts.subject_id, subjectId),
        ),
      )
    return row ? rowToMount(row) : null
  }

  async upsert(mount: WorkspaceMount): Promise<void> {
    await this.db
      .insert(workspaceMounts)
      .values({
        workspace_id: mount.workspaceId,
        subject_kind: mount.subjectKind,
        subject_id: mount.subjectId,
        pos_x: mount.position.x,
        pos_y: mount.position.y,
        width: mount.size?.w ?? null,
        height: mount.size?.h ?? null,
        created_at: mount.createdAt,
      })
      .onConflictDoUpdate({
        target: [workspaceMounts.workspace_id, workspaceMounts.subject_id],
        set: {
          pos_x: mount.position.x,
          pos_y: mount.position.y,
          width: mount.size?.w ?? null,
          height: mount.size?.h ?? null,
        },
      })
  }

  async update(workspaceId: string, subjectId: string, patch: WorkspaceMountPatch): Promise<void> {
    const set: Record<string, unknown> = {}
    if (patch.position) {
      set.pos_x = patch.position.x
      set.pos_y = patch.position.y
    }
    if ('size' in patch) {
      set.width = patch.size?.w ?? null
      set.height = patch.size?.h ?? null
    }
    if (Object.keys(set).length === 0) return
    await this.db
      .update(workspaceMounts)
      .set(set)
      .where(
        and(
          eq(workspaceMounts.workspace_id, workspaceId),
          eq(workspaceMounts.subject_id, subjectId),
        ),
      )
  }

  async remove(workspaceId: string, subjectId: string): Promise<void> {
    await this.db
      .delete(workspaceMounts)
      .where(
        and(
          eq(workspaceMounts.workspace_id, workspaceId),
          eq(workspaceMounts.subject_id, subjectId),
        ),
      )
  }

  async removeBySubjects(subjectIds: string[]): Promise<void> {
    if (subjectIds.length === 0) return
    // Chunk the IN list to stay well under the bind-parameter limit.
    for (let i = 0; i < subjectIds.length; i += 500) {
      await this.db
        .delete(workspaceMounts)
        .where(inArray(workspaceMounts.subject_id, subjectIds.slice(i, i + 500)))
    }
  }
}
