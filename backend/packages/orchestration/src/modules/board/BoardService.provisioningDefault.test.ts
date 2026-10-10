import { describe, expect, it } from 'vitest'
import type { Block, WorkspaceSettings } from '@cat-factory/kernel'
import { DEFAULT_WORKSPACE_SETTINGS } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

// The workspace's default test-environment provisioning mechanism has to reach BOTH frame-creation
// paths — the drag-drop `addFrame` and the "import an existing repo" `addServiceFromRepo` — or a
// board would seed the default on one kind of service and silently not the other. The pure
// precedence lives in serviceProvisioningDefaults.test.ts; these pin the wiring.
describe('BoardService seeds a new service frame with the workspace default provisioning', () => {
  const WS = 'ws_1'

  function build(settings: Partial<WorkspaceSettings> | null) {
    const inserted: Block[] = []
    const deps = {
      workspaceRepository: { get: async (id: string) => ({ id }) },
      blockRepository: {
        listByWorkspace: async () => [],
        insert: async (_ws: string, block: Block) => {
          inserted.push(block)
        },
      },
      repoProjectionRepository: {
        get: async () => ({
          githubId: 42,
          owner: 'acme',
          name: 'api',
          installationId: 7,
          isMonorepo: false,
        }),
      },
      idGenerator: { next: (prefix: string) => `${prefix}_new` },
      clock: { now: () => 1_000 },
      // `null` models a facade that wired no settings seam at all (tests / conformance).
      ...(settings
        ? {
            workspaceSettings: {
              get: async (): Promise<WorkspaceSettings> => ({
                ...DEFAULT_WORKSPACE_SETTINGS,
                ...settings,
              }),
            },
          }
        : {}),
    } as unknown as BoardServiceDependencies
    return { svc: new BoardService(deps), inserted }
  }

  it('stamps the default onto a dragged-in frame', async () => {
    const { svc, inserted } = build({ defaultProvisionType: 'kubernetes' })
    await svc.addFrame(WS, { type: 'service', position: { x: 0, y: 0 } })
    expect(inserted[0]?.provisioning).toEqual({ type: 'kubernetes' })
  })

  it('stamps the default onto a frame imported from a repo', async () => {
    const { svc, inserted } = build({ defaultProvisionType: 'docker-compose' })
    await svc.addServiceFromRepo(WS, { repoGithubId: 42 })
    expect(inserted[0]?.provisioning).toEqual({ type: 'docker-compose' })
  })

  it('carries the pinned manifest id for a custom default', async () => {
    const { svc, inserted } = build({
      defaultProvisionType: 'custom',
      defaultProvisionManifestId: 'acme-preview',
    })
    await svc.addFrame(WS, { type: 'service', position: { x: 0, y: 0 } })
    expect(inserted[0]?.provisioning).toEqual({ type: 'custom', manifestId: 'acme-preview' })
  })

  it('leaves the frame untouched when the workspace has recorded no choice', async () => {
    // The pre-existing behaviour, byte for byte: no `provisioning` key at all (every reader
    // treats that as `infraless`), NOT an explicit `infraless` nobody chose.
    const { svc, inserted } = build({ defaultProvisionType: null })
    await svc.addFrame(WS, { type: 'service', position: { x: 0, y: 0 } })
    expect(inserted[0]).not.toHaveProperty('provisioning')
  })

  it('leaves the frame untouched when no settings seam is wired', async () => {
    const { svc, inserted } = build(null)
    await svc.addFrame(WS, { type: 'service', position: { x: 0, y: 0 } })
    expect(inserted[0]).not.toHaveProperty('provisioning')
  })
})
