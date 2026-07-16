// Drizzle/Postgres implementations of the core kernel repository ports, split by
// domain (mirrors the Cloudflare D1 per-repository layout). The row<->domain mapping
// is the SAME shared mapping the D1 repos use (@cat-factory/server), so behaviour
// matches across stores; this layer only owns the Drizzle queries. Assembled into the
// CoreRepositories set by ./drizzle.ts (the barrel).

import type {
  Block,
  BlockPatch,
  BlockRepository,
  Service,
  ServiceFragmentDefaultsRepository,
  ServicePatch,
  ServiceRehome,
  ServiceRepository,
  Workspace,
  WorkspaceMount,
  WorkspaceMountPatch,
  WorkspaceMountRepository,
  WorkspaceRepository,
  WorkspaceVisibility,
} from '@cat-factory/kernel'
import { WORKSPACE_SCOPED_TABLES } from '@cat-factory/kernel'
import {
  blockInsertValues,
  blockPatchToColumns,
  rowToBlock,
  rowToWorkspace,
  tryDecodeRows,
} from '@cat-factory/server'
import { and, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import {
  agentRuns,
  blocks,
  services,
  workspaceFragmentDefaults,
  workspaceServices,
  workspaces,
} from '../../db/schema.js'

export class DrizzleWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listVisible(scope: WorkspaceVisibility): Promise<Workspace[]> {
    if (scope === null) {
      const rows = await this.db.select().from(workspaces).orderBy(desc(workspaces.created_at))
      return rows.map(rowToWorkspace)
    }
    const legacy = and(
      isNull(workspaces.account_id),
      eq(workspaces.owner_user_id, scope.ownerUserId),
    )
    const where =
      scope.accountIds.length > 0
        ? or(inArray(workspaces.account_id, scope.accountIds), legacy)
        : legacy
    const rows = await this.db
      .select()
      .from(workspaces)
      .where(where)
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

  async create(
    workspace: Workspace,
    ownerUserId: string | null,
    accountId: string | null,
  ): Promise<void> {
    await this.db.insert(workspaces).values({
      id: workspace.id,
      name: workspace.name,
      description: workspace.description,
      created_at: workspace.createdAt,
      owner_user_id: ownerUserId,
      account_id: accountId,
    })
  }

  async rename(id: string, name: string): Promise<void> {
    await this.db.update(workspaces).set({ name }).where(eq(workspaces.id, id))
  }

  async setDescription(id: string, description: string | null): Promise<void> {
    await this.db.update(workspaces).set({ description }).where(eq(workspaces.id, id))
  }

  async delete(id: string, rehome: ServiceRehome[] = []): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Re-home shared services FIRST: move each service's blocks + run history to a surviving
      // mounting board by re-stamping their `workspace_id`. Blocks are keyed by `service_id`, so
      // after the move the service's frame no longer lives in THIS workspace — the reclaim below
      // then skips it, leaving the service, its subtree and every OTHER board's mount intact. A
      // shared service therefore outlives its home board's deletion. Mirror any change in the
      // Cloudflare facade's D1WorkspaceRepository.delete.
      for (const { serviceId, toWorkspaceId } of rehome) {
        await tx
          .update(agentRuns)
          .set({ workspace_id: toWorkspaceId })
          .where(
            inArray(
              agentRuns.block_id,
              tx.select({ id: blocks.id }).from(blocks).where(eq(blocks.service_id, serviceId)),
            ),
          )
        await tx
          .update(blocks)
          .set({ workspace_id: toWorkspaceId })
          .where(eq(blocks.service_id, serviceId))
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
        await tx.delete(workspaceServices).where(inArray(workspaceServices.service_id, serviceIds))
        await tx.delete(services).where(inArray(services.id, serviceIds))
      }
      // This workspace's OWN mounts of services homed elsewhere (shared services it mounted).
      await tx.delete(workspaceServices).where(eq(workspaceServices.workspace_id, id))
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

  async listByService(serviceId: string): Promise<Block[]> {
    const rows = await this.db
      .select()
      .from(blocks)
      .where(eq(blocks.service_id, serviceId))
      .orderBy(blocks.seq)
    return tryDecodeRows(rows, rowToBlock, (r) => ({ table: 'blocks', id: r.id }))
  }

  async listByServices(serviceIds: string[]): Promise<Block[]> {
    if (serviceIds.length === 0) return []
    const out: Block[] = []
    // Chunk the IN list to stay well under the bind-parameter limit. Ordering is
    // per-chunk, matching the D1 twin's per-chunk `ORDER BY rowid`.
    for (let i = 0; i < serviceIds.length; i += 500) {
      const rows = await this.db
        .select()
        .from(blocks)
        .where(inArray(blocks.service_id, serviceIds.slice(i, i + 500)))
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

  async findById(
    blockId: string,
  ): Promise<{ workspaceId: string; serviceId: string | null; block: Block } | null> {
    const [row] = await this.db.select().from(blocks).where(eq(blocks.id, blockId)).limit(1)
    if (!row) return null
    return {
      workspaceId: row.workspace_id,
      serviceId: row.service_id ?? null,
      block: rowToBlock(row),
    }
  }

  async findByIds(
    blockIds: string[],
  ): Promise<Array<{ workspaceId: string; serviceId: string | null; block: Block }>> {
    if (blockIds.length === 0) return []
    const out: Array<{ workspaceId: string; serviceId: string | null; block: Block }> = []
    // Chunk the IN list to stay well under the bind-parameter limit.
    for (let i = 0; i < blockIds.length; i += 500) {
      const rows = await this.db
        .select()
        .from(blocks)
        .where(inArray(blocks.id, blockIds.slice(i, i + 500)))
      out.push(
        ...rows.map((row) => ({
          workspaceId: row.workspace_id,
          serviceId: row.service_id ?? null,
          block: rowToBlock(row),
        })),
      )
    }
    return out
  }

  async insert(workspaceId: string, block: Block, serviceId?: string | null): Promise<void> {
    await this.db.insert(blocks).values({
      workspace_id: workspaceId,
      service_id: serviceId ?? null,
      ...blockInsertValues(block),
    } as typeof blocks.$inferInsert)
  }

  async update(workspaceId: string, id: string, patch: BlockPatch): Promise<void> {
    const set = blockPatchToColumns(patch)
    if (Object.keys(set).length === 0) return
    await this.db
      .update(blocks)
      .set(set as Partial<typeof blocks.$inferInsert>)
      .where(and(eq(blocks.workspace_id, workspaceId), eq(blocks.id, id)))
  }

  async setService(workspaceId: string, ids: string[], serviceId: string | null): Promise<void> {
    if (ids.length === 0) return
    await this.db
      .update(blocks)
      .set({ service_id: serviceId })
      .where(and(eq(blocks.workspace_id, workspaceId), inArray(blocks.id, ids)))
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

  async getByRepo(installationId: number, repoGithubId: number): Promise<Service | null> {
    const [row] = await this.db
      .select()
      .from(services)
      .where(
        and(
          eq(services.installation_id, installationId),
          eq(services.repo_github_id, repoGithubId),
        ),
      )
    return row ? rowToService(row) : null
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

function rowToMount(row: typeof workspaceServices.$inferSelect): WorkspaceMount {
  return {
    workspaceId: row.workspace_id,
    serviceId: row.service_id,
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
      .from(workspaceServices)
      .where(eq(workspaceServices.workspace_id, workspaceId))
      .orderBy(workspaceServices.created_at)
    return rows.map(rowToMount)
  }

  async listByService(serviceId: string): Promise<WorkspaceMount[]> {
    const rows = await this.db
      .select()
      .from(workspaceServices)
      .where(eq(workspaceServices.service_id, serviceId))
      .orderBy(workspaceServices.created_at)
    return rows.map(rowToMount)
  }

  async listByServiceIds(serviceIds: string[]): Promise<WorkspaceMount[]> {
    if (serviceIds.length === 0) return []
    const rows = await this.db
      .select()
      .from(workspaceServices)
      .where(inArray(workspaceServices.service_id, serviceIds))
      .orderBy(workspaceServices.created_at)
    return rows.map(rowToMount)
  }

  async listWorkspaceIdsMountingBlock(
    originWorkspaceId: string,
    blockId: string,
  ): Promise<string[]> {
    // One join: the service owning the block → the workspaces that mount it. A block with no
    // service makes the subquery NULL, which matches no rows (`service_id = NULL`) → empty.
    const rows = await this.db
      .select({ workspaceId: workspaceServices.workspace_id })
      .from(workspaceServices)
      .where(
        sql`${workspaceServices.service_id} = (SELECT ${blocks.service_id} FROM ${blocks} WHERE ${blocks.workspace_id} = ${originWorkspaceId} AND ${blocks.id} = ${blockId})`,
      )
    return rows.map((r) => r.workspaceId)
  }

  async countByServiceIds(serviceIds: string[]): Promise<Record<string, number>> {
    if (serviceIds.length === 0) return {}
    const rows = await this.db
      .select({ serviceId: workspaceServices.service_id, n: sql<number>`count(*)` })
      .from(workspaceServices)
      .where(inArray(workspaceServices.service_id, serviceIds))
      .groupBy(workspaceServices.service_id)
    const counts: Record<string, number> = {}
    for (const row of rows) counts[row.serviceId] = Number(row.n)
    return counts
  }

  async get(workspaceId: string, serviceId: string): Promise<WorkspaceMount | null> {
    const [row] = await this.db
      .select()
      .from(workspaceServices)
      .where(
        and(
          eq(workspaceServices.workspace_id, workspaceId),
          eq(workspaceServices.service_id, serviceId),
        ),
      )
    return row ? rowToMount(row) : null
  }

  async upsert(mount: WorkspaceMount): Promise<void> {
    await this.db
      .insert(workspaceServices)
      .values({
        workspace_id: mount.workspaceId,
        service_id: mount.serviceId,
        pos_x: mount.position.x,
        pos_y: mount.position.y,
        width: mount.size?.w ?? null,
        height: mount.size?.h ?? null,
        created_at: mount.createdAt,
      })
      .onConflictDoUpdate({
        target: [workspaceServices.workspace_id, workspaceServices.service_id],
        set: {
          pos_x: mount.position.x,
          pos_y: mount.position.y,
          width: mount.size?.w ?? null,
          height: mount.size?.h ?? null,
        },
      })
  }

  async update(workspaceId: string, serviceId: string, patch: WorkspaceMountPatch): Promise<void> {
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
      .update(workspaceServices)
      .set(set)
      .where(
        and(
          eq(workspaceServices.workspace_id, workspaceId),
          eq(workspaceServices.service_id, serviceId),
        ),
      )
  }

  async remove(workspaceId: string, serviceId: string): Promise<void> {
    await this.db
      .delete(workspaceServices)
      .where(
        and(
          eq(workspaceServices.workspace_id, workspaceId),
          eq(workspaceServices.service_id, serviceId),
        ),
      )
  }

  async removeByServices(serviceIds: string[]): Promise<void> {
    if (serviceIds.length === 0) return
    // Chunk the IN list to stay well under the bind-parameter limit.
    for (let i = 0; i < serviceIds.length; i += 500) {
      await this.db
        .delete(workspaceServices)
        .where(inArray(workspaceServices.service_id, serviceIds.slice(i, i + 500)))
    }
  }
}
