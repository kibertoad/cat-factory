import type { BinaryArtifactMetadataStore, BinaryArtifactRecord } from '@cat-factory/kernel'
import { NotFoundError, createBinaryArtifactStore } from '@cat-factory/kernel'
import { MAX_TASK_IMAGES } from '@cat-factory/contracts'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import { artifactController } from '../src/modules/artifacts/ArtifactController.js'

// The images a person attaches to a task go through the workspace artifact endpoint as
// `kind: context`. What is pinned here is what the SPA relies on: the per-task ceiling refuses with
// a reason it can word, an attached image needs a real TASK, it lives at the task's HOME workspace
// whichever board attached it, and only a person's own uploads delete.

/** `blk_shared` homes in `ws_home` and is seen from `ws_1` through a mount; `frm_1` is a frame. */
const BLOCKS: Record<string, { home: string; level: string }> = {
  blk_1: { home: 'ws_1', level: 'task' },
  blk_2: { home: 'ws_1', level: 'task' },
  blk_shared: { home: 'ws_home', level: 'task' },
  frm_1: { home: 'ws_1', level: 'frame' },
}

function memoryMetadata(): BinaryArtifactMetadataStore {
  const rows = new Map<string, BinaryArtifactRecord>()
  const byBlock = (ws: string, blockId: string) =>
    [...rows.values()].filter((r) => r.workspaceId === ws && r.blockId === blockId)
  return {
    insert: async (record) => void rows.set(record.id, record),
    get: async (ws, id) => (rows.get(id)?.workspaceId === ws ? rows.get(id)! : null),
    listByBlock: async (ws, blockId) => byBlock(ws, blockId),
    countByBlock: async (ws, blockId) => byBlock(ws, blockId).length,
    delete: async (_ws, id) => void rows.delete(id),
    deleteByIds: async (_ws, ids) => ids.filter((id) => rows.delete(id)).length,
  } as BinaryArtifactMetadataStore
}

function makeApp() {
  let seq = 0
  const store = createBinaryArtifactStore({
    metadata: memoryMetadata(),
    blob: {
      kind: 'memory',
      put: async () => {},
      get: async () => new Uint8Array([1]),
      delete: async () => {},
    },
    idGenerator: { next: (p: string) => `${p}_${(seq += 1)}` },
    clock: { now: () => seq },
  })
  const boardService = {
    resolveBlockHome: async (_ws: string, id: string) => {
      const found = BLOCKS[id]
      if (!found) throw new NotFoundError('Block', id)
      return { homeWorkspaceId: found.home, block: { id, level: found.level } }
    },
  }
  const container = {
    resolveBinaryArtifactStore: async () => store,
    boardService,
  } as unknown as ServerContainer
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  app.route('/workspaces/:workspaceId', artifactController())
  app.onError(handleError)
  return { app, store }
}

function upload(app: Hono<AppEnv>, fields: Record<string, string>) {
  const form = new FormData()
  form.append(
    'file',
    new File([new Uint8Array([137, 80, 78, 71])], 'crash.png', { type: 'image/png' }),
  )
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  return app.fetch(
    new Request('http://x/workspaces/ws_1/artifacts', { method: 'POST', body: form }),
  )
}

describe('task images through the artifact endpoint', () => {
  it('stores an attached image against its task, up to the per-task ceiling', async () => {
    const { app } = makeApp()
    for (let i = 0; i < MAX_TASK_IMAGES; i += 1) {
      const res = await upload(app, { kind: 'context', blockId: 'blk_1', view: `img-${i}.png` })
      expect(res.status).toBe(201)
    }
    const refused = await upload(app, { kind: 'context', blockId: 'blk_1', view: 'one-more.png' })
    expect(refused.status).toBe(422)
    expect(await refused.json()).toMatchObject({
      error: { details: { reason: 'task_image_limit_reached', limit: MAX_TASK_IMAGES } },
    })
    // The ceiling is per task: another task still takes images.
    expect((await upload(app, { kind: 'context', blockId: 'blk_2' })).status).toBe(201)
  })

  it('refuses an attached image that names no task', async () => {
    const { app } = makeApp()
    const res = await upload(app, { kind: 'context' })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({
      error: { details: { reason: 'task_image_block_required' } },
    })
  })

  it('refuses an image on a block that is not a task, or that this board cannot see', async () => {
    const { app } = makeApp()
    const frame = await upload(app, { kind: 'context', blockId: 'frm_1' })
    expect(frame.status).toBe(422)
    expect(await frame.json()).toMatchObject({
      error: { details: { reason: 'task_image_block_not_task' } },
    })
    expect((await upload(app, { kind: 'context', blockId: 'blk_invented' })).status).toBe(404)
  })

  it('stores, lists and serves an image at the task HOME when attached from a mounting board', async () => {
    const { app, store } = makeApp()
    const created = (await (
      await upload(app, { kind: 'context', blockId: 'blk_shared' })
    ).json()) as { artifact: { id: string; workspaceId: string } }
    expect(created.artifact.workspaceId).toBe('ws_home')
    expect(await store.getMetadata('ws_1', created.artifact.id)).toBeNull()

    const listed = await app.fetch(new Request('http://x/workspaces/ws_1/blocks/blk_shared/images'))
    expect(((await listed.json()) as { artifacts: { id: string }[] }).artifacts).toEqual([
      expect.objectContaining({ id: created.artifact.id }),
    ])
    const blob = await app.fetch(
      new Request(`http://x/workspaces/ws_1/blocks/blk_shared/images/${created.artifact.id}/blob`),
    )
    expect(blob.status).toBe(200)

    const removed = await app.fetch(
      new Request(`http://x/workspaces/ws_1/blocks/blk_shared/images/${created.artifact.id}`, {
        method: 'DELETE',
      }),
    )
    expect(removed.status).toBe(204)
    expect(await store.getMetadata('ws_home', created.artifact.id)).toBeNull()
  })

  it('removes an image only through its own task, and answers 404 for a run capture', async () => {
    const { app, store } = makeApp()
    const created = (await (await upload(app, { kind: 'context', blockId: 'blk_1' })).json()) as {
      artifact: { id: string }
    }
    const capture = await store.store({
      meta: {
        workspaceId: 'ws_1',
        executionId: 'ex_1',
        blockId: 'blk_1',
        kind: 'screenshot',
        view: 'Checkout',
        contentType: 'image/png',
      },
      blob: new Uint8Array([1]),
    })
    const del = (blockId: string, id: string) =>
      app.fetch(
        new Request(`http://x/workspaces/ws_1/blocks/${blockId}/images/${id}`, {
          method: 'DELETE',
        }),
      )

    expect((await del('blk_2', created.artifact.id)).status).toBe(404)
    expect((await del('blk_1', capture.id)).status).toBe(404)
    expect(await store.getMetadata('ws_1', capture.id)).not.toBeNull()
    expect((await del('blk_1', created.artifact.id)).status).toBe(204)
    expect(await store.getMetadata('ws_1', created.artifact.id)).toBeNull()
  })
})
