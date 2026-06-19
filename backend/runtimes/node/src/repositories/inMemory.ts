import type {
  AccountRecord,
  AccountRepository,
  AgentFailure,
  AgentRunRef,
  AgentRunRepository,
  Block,
  BlockPatch,
  BlockRepository,
  ExecutionInstance,
  ExecutionRepository,
  Membership,
  MembershipRepository,
  Pipeline,
  PipelineRepository,
  RunRef,
  TokenUsageRecord,
  TokenUsageRepository,
  TokenUsageTotals,
  Workspace,
  WorkspaceRepository,
  WorkspaceVisibility,
} from '@cat-factory/kernel'

// An in-memory persistence layer implementing the core kernel repository ports.
// It makes the Node facade runnable with zero external infrastructure (great for
// local dev, smoke tests and the first end-to-end runs) and, crucially, proves the
// shared controllers + domain core run unchanged on Node. A Drizzle/Postgres layer
// implements the SAME ports for production — a drop-in swap behind `buildNodeContainer`.
//
// NOTE: process-local and non-durable — state is lost on restart and not shared
// across instances. Not for production.

class InMemoryWorkspaceRepository implements WorkspaceRepository {
  private readonly rows = new Map<
    string,
    { workspace: Workspace; ownerUserId: number | null; accountId: string | null }
  >()

  listVisible(scope: WorkspaceVisibility): Promise<Workspace[]> {
    const all = [...this.rows.values()]
    if (scope === null) return Promise.resolve(all.map((r) => r.workspace))
    const accountIds = new Set(scope.accountIds)
    return Promise.resolve(
      all
        .filter(
          (r) =>
            (r.accountId !== null && accountIds.has(r.accountId)) ||
            (r.accountId === null && r.ownerUserId === scope.ownerUserId),
        )
        .map((r) => r.workspace),
    )
  }

  get(id: string): Promise<Workspace | null> {
    return Promise.resolve(this.rows.get(id)?.workspace ?? null)
  }

  ownerOf(id: string): Promise<number | null | undefined> {
    const row = this.rows.get(id)
    return Promise.resolve(row ? row.ownerUserId : undefined)
  }

  accountOf(id: string): Promise<string | null | undefined> {
    const row = this.rows.get(id)
    return Promise.resolve(row ? row.accountId : undefined)
  }

  create(
    workspace: Workspace,
    ownerUserId: number | null,
    accountId: string | null,
  ): Promise<void> {
    this.rows.set(workspace.id, { workspace, ownerUserId, accountId })
    return Promise.resolve()
  }

  rename(id: string, name: string): Promise<void> {
    const row = this.rows.get(id)
    if (row) row.workspace = { ...row.workspace, name }
    return Promise.resolve()
  }

  delete(id: string): Promise<void> {
    this.rows.delete(id)
    return Promise.resolve()
  }
}

/** A Map keyed by workspace id, each holding a Map of entity id → entity. */
class ByWorkspace<T extends { id: string }> {
  protected readonly byWs = new Map<string, Map<string, T>>()

  protected bucket(workspaceId: string): Map<string, T> {
    let m = this.byWs.get(workspaceId)
    if (!m) {
      m = new Map()
      this.byWs.set(workspaceId, m)
    }
    return m
  }

  list(workspaceId: string): T[] {
    return [...(this.byWs.get(workspaceId)?.values() ?? [])]
  }

  read(workspaceId: string, id: string): T | null {
    return this.byWs.get(workspaceId)?.get(id) ?? null
  }
}

class InMemoryBlockRepository extends ByWorkspace<Block> implements BlockRepository {
  listByWorkspace(workspaceId: string): Promise<Block[]> {
    return Promise.resolve(this.list(workspaceId))
  }

  get(workspaceId: string, id: string): Promise<Block | null> {
    return Promise.resolve(this.read(workspaceId, id))
  }

  insert(workspaceId: string, block: Block): Promise<void> {
    this.bucket(workspaceId).set(block.id, block)
    return Promise.resolve()
  }

  update(workspaceId: string, id: string, patch: BlockPatch): Promise<void> {
    const existing = this.read(workspaceId, id)
    if (existing) this.bucket(workspaceId).set(id, { ...existing, ...patch })
    return Promise.resolve()
  }

  deleteMany(workspaceId: string, ids: string[]): Promise<void> {
    const bucket = this.bucket(workspaceId)
    for (const id of ids) bucket.delete(id)
    return Promise.resolve()
  }
}

class InMemoryPipelineRepository extends ByWorkspace<Pipeline> implements PipelineRepository {
  listByWorkspace(workspaceId: string): Promise<Pipeline[]> {
    return Promise.resolve(this.list(workspaceId))
  }

  get(workspaceId: string, id: string): Promise<Pipeline | null> {
    return Promise.resolve(this.read(workspaceId, id))
  }

  insert(workspaceId: string, pipeline: Pipeline): Promise<void> {
    this.bucket(workspaceId).set(pipeline.id, pipeline)
    return Promise.resolve()
  }

  delete(workspaceId: string, id: string): Promise<void> {
    this.bucket(workspaceId).delete(id)
    return Promise.resolve()
  }
}

interface ExecutionRow {
  instance: ExecutionInstance
  updatedAt: number
}

class InMemoryExecutionRepository implements ExecutionRepository {
  // workspaceId → executionId → row (instance + lease timestamp)
  private readonly byWs = new Map<string, Map<string, ExecutionRow>>()

  constructor(private readonly now: () => number) {}

  private bucket(workspaceId: string): Map<string, ExecutionRow> {
    let m = this.byWs.get(workspaceId)
    if (!m) {
      m = new Map()
      this.byWs.set(workspaceId, m)
    }
    return m
  }

  listByWorkspace(workspaceId: string): Promise<ExecutionInstance[]> {
    return Promise.resolve([...(this.byWs.get(workspaceId)?.values() ?? [])].map((r) => r.instance))
  }

  get(workspaceId: string, id: string): Promise<ExecutionInstance | null> {
    return Promise.resolve(this.byWs.get(workspaceId)?.get(id)?.instance ?? null)
  }

  getByBlock(workspaceId: string, blockId: string): Promise<ExecutionInstance | null> {
    const found = [...(this.byWs.get(workspaceId)?.values() ?? [])].find(
      (r) => r.instance.blockId === blockId,
    )
    return Promise.resolve(found?.instance ?? null)
  }

  upsert(workspaceId: string, execution: ExecutionInstance): Promise<void> {
    this.bucket(workspaceId).set(execution.id, { instance: execution, updatedAt: this.now() })
    return Promise.resolve()
  }

  deleteByBlock(workspaceId: string, blockId: string): Promise<void> {
    const bucket = this.byWs.get(workspaceId)
    if (bucket) {
      for (const [id, row] of bucket) if (row.instance.blockId === blockId) bucket.delete(id)
    }
    return Promise.resolve()
  }

  listStale(olderThanEpochMs: number): Promise<RunRef[]> {
    const stale: RunRef[] = []
    for (const [workspaceId, bucket] of this.byWs) {
      for (const row of bucket.values()) {
        if (row.instance.status === 'running' && row.updatedAt < olderThanEpochMs) {
          stale.push({ workspaceId, id: row.instance.id })
        }
      }
    }
    return Promise.resolve(stale)
  }

  markFailed(workspaceId: string, id: string, failure: AgentFailure): Promise<void> {
    const row = this.byWs.get(workspaceId)?.get(id)
    if (row) {
      row.instance = { ...row.instance, status: 'failed', failure }
      row.updatedAt = this.now()
    }
    return Promise.resolve()
  }

  /** Cross-kind ref lookup for the unified retry/sweeper surface (execution kind only here). */
  refOf(workspaceId: string, id: string): AgentRunRef | null {
    return this.byWs.get(workspaceId)?.has(id) ? { workspaceId, id, kind: 'execution' } : null
  }
}

class InMemoryAccountRepository implements AccountRepository {
  private readonly rows = new Map<string, AccountRecord>()

  get(id: string): Promise<AccountRecord | null> {
    return Promise.resolve(this.rows.get(id) ?? null)
  }

  create(account: AccountRecord): Promise<void> {
    this.rows.set(account.id, account)
    return Promise.resolve()
  }

  rename(id: string, name: string): Promise<void> {
    const row = this.rows.get(id)
    if (row) this.rows.set(id, { ...row, name })
    return Promise.resolve()
  }

  findPersonalByLogin(login: string): Promise<AccountRecord | null> {
    const found = [...this.rows.values()].find(
      (a) => a.type === 'personal' && a.githubAccountLogin === login,
    )
    return Promise.resolve(found ?? null)
  }
}

class InMemoryMembershipRepository implements MembershipRepository {
  private readonly rows: Membership[] = []

  listByUser(userId: number): Promise<Membership[]> {
    return Promise.resolve(this.rows.filter((m) => m.userId === userId))
  }

  listByAccount(accountId: string): Promise<Membership[]> {
    return Promise.resolve(this.rows.filter((m) => m.accountId === accountId))
  }

  get(accountId: string, userId: number): Promise<Membership | null> {
    return Promise.resolve(
      this.rows.find((m) => m.accountId === accountId && m.userId === userId) ?? null,
    )
  }

  upsert(membership: Membership): Promise<void> {
    const i = this.rows.findIndex(
      (m) => m.accountId === membership.accountId && m.userId === membership.userId,
    )
    if (i >= 0) this.rows[i] = membership
    else this.rows.push(membership)
    return Promise.resolve()
  }

  remove(accountId: string, userId: number): Promise<void> {
    const i = this.rows.findIndex((m) => m.accountId === accountId && m.userId === userId)
    if (i >= 0) this.rows.splice(i, 1)
    return Promise.resolve()
  }
}

class InMemoryTokenUsageRepository implements TokenUsageRepository {
  private readonly rows: TokenUsageRecord[] = []

  record(usage: TokenUsageRecord): Promise<void> {
    this.rows.push(usage)
    return Promise.resolve()
  }

  totalsSince(epochMs: number): Promise<TokenUsageTotals> {
    const totals: TokenUsageTotals = { inputTokens: 0, outputTokens: 0, costEstimate: 0 }
    for (const r of this.rows) {
      if (r.createdAt >= epochMs) {
        totals.inputTokens += r.inputTokens
        totals.outputTokens += r.outputTokens
        totals.costEstimate += r.costEstimate
      }
    }
    return Promise.resolve(totals)
  }

  deleteOlderThan(epochMs: number): Promise<number> {
    let removed = 0
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (this.rows[i]!.createdAt < epochMs) {
        this.rows.splice(i, 1)
        removed++
      }
    }
    return Promise.resolve(removed)
  }
}

/** Kind-spanning view; here only execution runs exist, so it defers to that store. */
class InMemoryAgentRunRepository implements AgentRunRepository {
  constructor(private readonly executions: InMemoryExecutionRepository) {}

  getRef(workspaceId: string, id: string): Promise<AgentRunRef | null> {
    return Promise.resolve(this.executions.refOf(workspaceId, id))
  }

  listStale(olderThanEpochMs: number): Promise<AgentRunRef[]> {
    return this.executions
      .listStale(olderThanEpochMs)
      .then((refs) => refs.map((r) => ({ ...r, kind: 'execution' as const })))
  }
}

export interface InMemoryRepositories {
  workspaceRepository: WorkspaceRepository
  accountRepository: AccountRepository
  membershipRepository: MembershipRepository
  blockRepository: BlockRepository
  pipelineRepository: PipelineRepository
  executionRepository: ExecutionRepository
  tokenUsageRepository: TokenUsageRepository
  agentRunRepository: AgentRunRepository
}

/** Build a fresh, process-local set of the core repositories. */
export function createInMemoryRepositories(
  now: () => number = () => Date.now(),
): InMemoryRepositories {
  const executionRepository = new InMemoryExecutionRepository(now)
  return {
    workspaceRepository: new InMemoryWorkspaceRepository(),
    accountRepository: new InMemoryAccountRepository(),
    membershipRepository: new InMemoryMembershipRepository(),
    blockRepository: new InMemoryBlockRepository(),
    pipelineRepository: new InMemoryPipelineRepository(),
    executionRepository,
    tokenUsageRepository: new InMemoryTokenUsageRepository(),
    agentRunRepository: new InMemoryAgentRunRepository(executionRepository),
  }
}
