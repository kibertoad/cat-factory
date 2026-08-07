import { describe, expect, it, vi } from 'vitest'
import type { CreateWorkspaceInput } from '@cat-factory/contracts'
import type {
  BlockRepository,
  EnvironmentHandlerSeeder,
  ExecutionRepository,
  PipelineRepository,
  RiskPolicy,
  RiskPolicyRepository,
  Workspace,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { seedRiskPolicies } from '@cat-factory/kernel'
import { WorkspaceService, type WorkspaceServiceDependencies } from './WorkspaceService.js'

// `create` seeds a new board's deployment-declared environment handlers through a LATE-BOUND
// accessor (the seeder is built after this service in the container). These tests pin that the
// accessor is invoked with the freshly-minted workspace id, and that creation still succeeds when
// no accessor is wired (tests / a deployment that declares no seeds).

// A `create`/`snapshot` fake: `create` captures the new board so `get` (used by the snapshot's
// existence guard + read) returns it; the list reads come back empty. Only the members these two
// paths reach are implemented.
function makeService(extra: Partial<WorkspaceServiceDependencies>) {
  let stored: Workspace | undefined
  const workspaceRepository = {
    create: vi.fn((ws: Workspace) => {
      stored = ws
      return Promise.resolve()
    }),
    get: (id: string) => Promise.resolve(stored && stored.id === id ? stored : null),
  } as unknown as WorkspaceRepository
  const blockRepository = {
    insert: vi.fn(() => Promise.resolve()),
    listByWorkspace: () => Promise.resolve([]),
  } as unknown as BlockRepository
  const pipelineRepository = {
    insert: vi.fn(() => Promise.resolve()),
    listByWorkspace: () => Promise.resolve([]),
  } as unknown as PipelineRepository
  const executionRepository = {
    listByWorkspace: () => Promise.resolve([]),
  } as unknown as ExecutionRepository
  const service = new WorkspaceService({
    workspaceRepository,
    blockRepository,
    pipelineRepository,
    executionRepository,
    idGenerator: { next: () => 'ws-new' },
    clock: { now: () => 1 },
    ...extra,
  })
  return { service }
}

// `seed: false` keeps the sample-architecture seeding out of the way — the seeder hook is
// independent of it (it runs whether or not the board is seeded).
const INPUT: CreateWorkspaceInput = { name: 'New board', seed: false }

describe('WorkspaceService.create — environment-handler seeding', () => {
  it('seeds the new workspace’s environment handlers via the late-bound accessor', async () => {
    const ensureForWorkspace = vi.fn(() => Promise.resolve())
    const seeder: EnvironmentHandlerSeeder = { ensureForWorkspace }
    const getEnvironmentHandlerSeeder = vi.fn(() => seeder)
    const { service } = makeService({ getEnvironmentHandlerSeeder })

    await service.create(INPUT, null, null)

    expect(getEnvironmentHandlerSeeder).toHaveBeenCalled()
    expect(ensureForWorkspace).toHaveBeenCalledWith('ws-new')
  })

  it('still creates the workspace when no seeder accessor is wired', async () => {
    const { service } = makeService({})

    const snapshot = await service.create(INPUT, null, null)

    expect(snapshot.workspace.id).toBe('ws-new')
  })

  it('still creates the workspace when the accessor resolves to no seeder', async () => {
    const getEnvironmentHandlerSeeder = vi.fn(() => undefined)
    const { service } = makeService({ getEnvironmentHandlerSeeder })

    const snapshot = await service.create(INPUT, null, null)

    expect(getEnvironmentHandlerSeeder).toHaveBeenCalled()
    expect(snapshot.workspace.id).toBe('ws-new')
  })
})

describe('WorkspaceService.create: merge-preset seeding', () => {
  // Which merge policy governs a run may not depend on whether anyone opened the board. The
  // library used to be written by the first `list()`, so a board reached only over the public
  // API had none and every run fell through to the refusing built-in fallback.
  function makeWithPresets() {
    const rows: RiskPolicy[] = []
    const riskPolicyRepository = {
      upsert: vi.fn((_ws: string, preset: RiskPolicy) => {
        rows.push(preset)
        return Promise.resolve()
      }),
      list: () => Promise.resolve(rows),
    } as unknown as RiskPolicyRepository
    return { ...makeService({ riskPolicyRepository }), rows }
  }

  it('writes the built-in preset library, with exactly one default', async () => {
    const { service, rows } = makeWithPresets()

    await service.create(INPUT, null, null)

    // Derived from the catalog the service reads, not pinned to a count: adding a built-in is an
    // ordinary change, and a hard number would fail on it while naming nothing about what broke.
    expect(rows.map((p) => p.id)).toEqual(seedRiskPolicies().map((p) => p.id))
    expect(rows.filter((p) => p.isDefault)).toHaveLength(1)
  })

  it('stamps createdAt in catalog order, which is the order `list` reads back', async () => {
    const { service, rows } = makeWithPresets()

    await service.create(INPUT, null, null)

    expect(rows.map((p) => p.createdAt)).toEqual(rows.map((p) => p.createdAt).sort((a, b) => a - b))
    expect(new Set(rows.map((p) => p.createdAt)).size).toBe(rows.length)
  })

  it('still creates the board when no preset repository is wired', async () => {
    // Such a deployment has genuinely configured no merge policy; its runs report that rather
    // than failing to create boards.
    const { service } = makeService({})

    const snapshot = await service.create(INPUT, null, null)

    expect(snapshot.workspace.id).toBe('ws-new')
  })
})
