import { describe, expect, it } from 'vitest'
import { ConflictError, NotFoundError, type Block } from '@cat-factory/kernel'
import { ContainerSessionService } from '../src/containers/ContainerSessionService.js'
import { makePreviewJobBuilder } from '../src/preview/previewJobBuilder.js'

function frontendFrame(over: Partial<Block> = {}): Block {
  return {
    id: 'blk_fe',
    workspaceId: 'ws',
    title: 'Web',
    level: 'frame',
    type: 'frontend',
    status: 'ready',
    parentId: null,
    frontendConfig: { backendBindings: [], servePort: 4173 },
    ...over,
  } as unknown as Block
}

function makeBuilder(block: Block | null, repo?: { installationId: number } | null) {
  return makePreviewJobBuilder({
    blockRepository: { get: async () => block } as never,
    resolveRepoTarget: async () =>
      repo === null
        ? null
        : ({ installationId: 7, owner: 'acme', name: 'web', baseBranch: 'main' } as never),
    mintInstallationToken: async () => 'gh-token',
    sessionService: new ContainerSessionService({ secret: 'x'.repeat(32) }),
    proxyBaseUrl: 'https://app.test/v1',
  })
}

describe('makePreviewJobBuilder', () => {
  it('builds a preview job body for a frontend frame', async () => {
    const plan = await makeBuilder(frontendFrame())({ workspaceId: 'ws', frameId: 'blk_fe' })
    expect(plan.jobId).toBe('preview')
    expect(plan.servePort).toBe(4173)
    expect(plan.spec).toMatchObject({
      jobId: 'preview',
      mode: 'preview',
      harness: 'pi',
      proxyBaseUrl: 'https://app.test/v1',
      ghToken: 'gh-token',
      branch: 'main',
      repo: { owner: 'acme', name: 'web', baseBranch: 'main', provider: 'github' },
    })
    expect((plan.spec.infra as { kind: string }).kind).toBe('frontend')
    expect(typeof plan.spec.sessionToken).toBe('string')
  })

  it('throws NotFoundError for an unknown frame', async () => {
    await expect(makeBuilder(null)({ workspaceId: 'ws', frameId: 'nope' })).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  it('rejects a non-frontend frame', async () => {
    const frame = frontendFrame({ type: 'service', frontendConfig: undefined } as Partial<Block>)
    await expect(
      makeBuilder(frame)({ workspaceId: 'ws', frameId: 'blk_fe' }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('rejects when no repo is connected', async () => {
    await expect(
      makeBuilder(frontendFrame(), null)({ workspaceId: 'ws', frameId: 'blk_fe' }),
    ).rejects.toBeInstanceOf(ConflictError)
  })
})
