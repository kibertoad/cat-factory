import { describe, expect, it } from 'vitest'
import { registerServiceForFrame, type ServiceRegistrationDeps } from './service-registration.js'
import type { Block, Service } from './types.js'
import type { WorkspaceMount } from './types.js'

// Every site that creates a top-level frame (board drops, repo import, seeded demo boards, repo
// bootstrap) goes through this, so what it writes is what makes a frame shareable. Two facts are
// load-bearing and neither is visible at the call site: the frame's board POSITION lands on the
// MOUNT (one shared service sits at a different spot on every board that mounts it), and an
// unwired facade is a clean no-op rather than a half-registered service.

const NOW = 1_700_000_000_000

function harness(over: { accountOf?: string | null } = {}) {
  const services: Service[] = []
  const mounts: WorkspaceMount[] = []
  let next = 0
  const deps: ServiceRegistrationDeps = {
    serviceRepository: { insert: async (s: Service) => void services.push(s) } as never,
    workspaceMountRepository: {
      upsert: async (m: WorkspaceMount) => void mounts.push(m),
    } as never,
    workspaceRepository: {
      accountOf: async () => ('accountOf' in over ? over.accountOf : 'acc_1'),
    } as never,
    idGenerator: { next: (prefix: string) => `${prefix}_${++next}` } as never,
    clock: { now: () => NOW },
  }
  return { deps, services, mounts }
}

const frame = (over: Partial<Block> = {}) =>
  ({ id: 'blk_frame', position: { x: 40, y: 80 }, ...over }) as Block

describe('registerServiceForFrame', () => {
  it('inserts the service and returns the id the frame block is stamped with', async () => {
    const { deps, services } = harness()
    const id = await registerServiceForFrame(deps, 'ws_1', frame())
    expect(id).toBe('svc_1')
    expect(services).toHaveLength(1)
    expect(services[0]).toMatchObject({
      id: 'svc_1',
      accountId: 'acc_1',
      frameBlockId: 'blk_frame',
      createdAt: NOW,
    })
  })

  it('puts the board POSITION on the mount, not on the service', async () => {
    // The service is account-owned and mounted by many boards; only the mount can say where it
    // sits on THIS one. A position written onto the service would place the frame identically on
    // every board that mounted it.
    const { deps, mounts, services } = harness()
    await registerServiceForFrame(deps, 'ws_1', frame({ size: { w: 400, h: 300 } }))
    expect(mounts[0]).toEqual({
      workspaceId: 'ws_1',
      serviceId: 'svc_1',
      position: { x: 40, y: 80 },
      size: { w: 400, h: 300 },
      createdAt: NOW,
    })
    expect(services[0]).not.toHaveProperty('position')
  })

  it('records an absent size override as null rather than dropping the field', async () => {
    const { deps, mounts } = harness()
    await registerServiceForFrame(deps, 'ws_1', frame())
    expect(mounts[0]?.size).toBeNull()
  })

  it('carries the repo linkage when one is supplied', async () => {
    const { deps, services } = harness()
    await registerServiceForFrame(deps, 'ws_1', frame(), {
      installationId: 55,
      githubId: 909,
      directory: 'apps/api',
    })
    expect(services[0]).toMatchObject({
      installationId: 55,
      repoGithubId: 909,
      directory: 'apps/api',
    })
  })

  it('records NO repo linkage as null on every leg, so a read cannot see `undefined`', async () => {
    const { deps, services } = harness()
    await registerServiceForFrame(deps, 'ws_1', frame())
    expect(services[0]).toMatchObject({
      installationId: null,
      repoGithubId: null,
      directory: null,
    })
    // A monorepo repo with no subdirectory is still a repo-linked service.
    const second = harness()
    await registerServiceForFrame(second.deps, 'ws_1', frame(), {
      installationId: 55,
      githubId: 909,
    })
    expect(second.services[0]?.directory).toBeNull()
  })

  it('records a workspace with no account as a null accountId, not as a failure', async () => {
    const { deps, services } = harness({ accountOf: null })
    await expect(registerServiceForFrame(deps, 'ws_1', frame())).resolves.toBe('svc_1')
    expect(services[0]?.accountId).toBeNull()
  })

  it('is a clean NO-OP when either service repository is unwired', async () => {
    // In-org sharing is opt-in, and a half-registered service (a row with no mount, or a mount
    // pointing at no row) is worse than none: the frame would be discoverable on no board.
    for (const missing of ['serviceRepository', 'workspaceMountRepository'] as const) {
      const { deps, services, mounts } = harness()
      await expect(
        registerServiceForFrame({ ...deps, [missing]: undefined }, 'ws_1', frame()),
      ).resolves.toBeUndefined()
      expect(services, missing).toEqual([])
      expect(mounts, missing).toEqual([])
    }
  })
})
