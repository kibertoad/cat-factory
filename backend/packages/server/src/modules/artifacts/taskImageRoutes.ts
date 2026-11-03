import type { Context, Hono } from 'hono'
import type { BinaryArtifactRecord, BinaryArtifactStore } from '@cat-factory/kernel'
import { NotFoundError, ValidationError } from '@cat-factory/kernel'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'
import { blobResponseBody, blobResponseHeaders } from './imageArtifacts.js'

/**
 * The images a person attached to a task live under the workspace that HOMES the task, never the
 * board the person is looking at: a task under a shared service is one row seen from every board
 * that mounts it, its runs execute at its home, and its block delete reclaims there. So every
 * read and write of a `context` image resolves the home first, through the same rule a board
 * mutation uses (a board that neither homes the task nor mounts its service gets a 404).
 */
export async function resolveTaskImageHome<E extends AppEnv>(
  c: Context<E>,
  blockId: string,
): Promise<{ workspaceId: string; store: BinaryArtifactStore }> {
  const container = c.get('container')
  const { homeWorkspaceId, block } = await container.boardService.resolveBlockHome(
    param(c, 'workspaceId'),
    blockId,
  )
  // Only a task is read for attached images (by its runs and its inspector), so an image on a
  // frame or an initiative would be retained with nothing ever showing or reclaiming it.
  if (block.level !== 'task') {
    throw new ValidationError('Images can only be attached to a task', {
      reason: 'task_image_block_not_task',
    })
  }
  const resolve = container.resolveBinaryArtifactStore
  const store = requireCapability(
    resolve ? await resolve(homeWorkspaceId) : null,
    'Binary-artifact storage is not configured',
  )
  return { workspaceId: homeWorkspaceId, store }
}

/** One attached image of THIS task, or a 404 for anything else the id might name. */
async function requireTaskImage(
  store: BinaryArtifactStore,
  workspaceId: string,
  blockId: string,
  id: string,
): Promise<BinaryArtifactRecord> {
  const record = await store.getMetadata(workspaceId, id)
  if (!record || record.kind !== 'context' || record.blockId !== blockId) {
    throw new NotFoundError('Artifact', id, { reason: 'artifact_not_found' })
  }
  return record
}

/** The read, serve and remove routes for a task's attached images (the upload is `POST /artifacts`). */
export function mountTaskImageRoutes(app: Hono<AppEnv>): void {
  app.get('/blocks/:blockId/images', async (c) => {
    const blockId = param(c, 'blockId')
    const { workspaceId, store } = await resolveTaskImageHome(c, blockId)
    const artifacts = (await store.listByBlock(workspaceId, blockId)).filter(
      (record) => record.kind === 'context',
    )
    return c.json({ artifacts }, 200)
  })

  app.get('/blocks/:blockId/images/:id/blob', async (c) => {
    const blockId = param(c, 'blockId')
    const id = param(c, 'id')
    const { workspaceId, store } = await resolveTaskImageHome(c, blockId)
    await requireTaskImage(store, workspaceId, blockId, id)
    const got = await store.getBlobWithMetadata(workspaceId, id)
    if (!got?.bytes) {
      throw new NotFoundError('Artifact', id, { reason: 'artifact_bytes_gone' })
    }
    return new Response(blobResponseBody(got.bytes), {
      status: 200,
      headers: blobResponseHeaders(got.record.contentType),
    })
  })

  app.delete('/blocks/:blockId/images/:id', async (c) => {
    const blockId = param(c, 'blockId')
    const id = param(c, 'id')
    const { workspaceId, store } = await resolveTaskImageHome(c, blockId)
    await requireTaskImage(store, workspaceId, blockId, id)
    await store.delete(workspaceId, id)
    return c.body(null, 204)
  })
}
