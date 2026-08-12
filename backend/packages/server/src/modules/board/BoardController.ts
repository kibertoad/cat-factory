import {
  addEpicContract,
  addFrameContract,
  addModuleContract,
  addServiceFromRepoContract,
  addTaskContract,
  archiveBlockContract,
  assignEpicContract,
  moveBlockContract,
  removeBlockContract,
  reparentBlockContract,
  resizeBlockContract,
  restoreBlockContract,
  toggleDependencyContract,
  updateBlockContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import { resolveViewerPat } from '../../github/viewerPat.js'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { blockEditAuthority } from '../../http/workspaceAccess.js'

/**
 * Board mutations. Mounted under `/workspaces/:workspaceId`, so every handler
 * reads the workspace id from the inherited path param.
 */
export function boardController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, addFrameContract, async (c) => {
    const block = await c
      .get('container')
      .boardService.addFrame(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(block, 201)
  })

  // Import an existing GitHub repo as a service frame — no bootstrap / agent run.
  // First link + sync the repo into the workspace (it may be App-accessible but
  // not yet tracked here), then create the `ready` frame and link the repo to it.
  // A 409 tells the client the App can't see the repo yet (grant it access); the
  // board service 404s an unknown repo and 422s one already on the board.
  buildHonoRoute(app, addServiceFromRepoContract, async (c) => {
    const container = c.get('container')
    const workspaceId = param(c, 'workspaceId')
    const { repoGithubId } = c.req.valid('json')
    if (container.github) {
      // Resolve the signed-in user's PAT so a repo only THEIR token can reach (beyond the App's
      // grant) still links — as a personal (`linkedVia:'user_pat'`) repo whose frame is redacted
      // for members without access. Best-effort: a decrypt failure degrades to App-only linking.
      const { userId, userToken } = await resolveViewerPat(c)
      const linked = await container.github.syncService.linkRepo(workspaceId, repoGithubId, {
        userId,
        userToken,
      })
      if (!linked) {
        return c.json(
          {
            error: {
              code: 'repo_not_accessible',
              message:
                'Neither the GitHub App nor your personal access token can reach this repository. ' +
                'Grant the App access (or add a PAT that can), then try again.',
            },
          },
          409,
        )
      }
    }
    const block = await container.boardService.addServiceFromRepo(workspaceId, c.req.valid('json'))
    return c.json(block, 201)
  })

  buildHonoRoute(app, addTaskContract, async (c) => {
    const block = await c.get('container').boardService.addTask(
      param(c, 'workspaceId'),
      c.req.valid('param').blockId,
      c.req.valid('json'),
      // Creating a task straight onto a merge preset is a policy decision, judged against the
      // author's own tier (ADR 0037), read through the one accessor and never off the gate here.
      blockEditAuthority(c),
      c.get('user')?.id ?? null,
    )
    return c.json(block, 201)
  })

  buildHonoRoute(app, addModuleContract, async (c) => {
    const block = await c
      .get('container')
      .boardService.addModule(
        param(c, 'workspaceId'),
        c.req.valid('param').blockId,
        c.req.valid('json'),
      )
    return c.json(block, 201)
  })

  // Add an epic grouping node (optionally placed under a service/module via parentId).
  buildHonoRoute(app, addEpicContract, async (c) => {
    const block = await c
      .get('container')
      .boardService.addEpic(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(block, 201)
  })

  // Assign a task to an epic, or detach it (epicId: null).
  buildHonoRoute(app, assignEpicContract, async (c) => {
    const block = await c
      .get('container')
      .boardService.assignToEpic(
        param(c, 'workspaceId'),
        c.req.valid('param').blockId,
        c.req.valid('json').epicId,
      )
    return c.json(block, 200)
  })

  buildHonoRoute(app, updateBlockContract, async (c) => {
    const block = await c.get('container').boardService.updateBlock(
      param(c, 'workspaceId'),
      c.req.valid('param').blockId,
      c.req.valid('json'),
      // A patch may re-point the task's merge preset, which is a policy decision judged against
      // the editor's own tier (ADR 0037), not an ordinary preference.
      blockEditAuthority(c),
      // Skip echoing this edit back to the tab that made it — its REST response already
      // carried the authoritative block, so a self-echo would only force a redundant
      // board-wide re-hydrate (the visible "board jumps" on rapid inspector edits). Same
      // `X-Connection-Id` / `?ticket=` plumbing move/reparent use.
      c.req.header('x-connection-id') ?? null,
    )
    return c.json(block, 200)
  })

  buildHonoRoute(app, moveBlockContract, async (c) => {
    const block = await c.get('container').boardService.moveBlock(
      param(c, 'workspaceId'),
      c.req.valid('param').blockId,
      c.req.valid('json').position,
      // Skip echoing this move back to the connection that made it (no self-refresh that
      // snaps an in-flight drag back to a stale position) — see the `X-Connection-Id` /
      // `?cid=` plumbing in the SPA and the realtime hubs.
      c.req.header('x-connection-id') ?? null,
    )
    return c.json(block, 200)
  })

  buildHonoRoute(app, reparentBlockContract, async (c) => {
    const block = await c.get('container').boardService.reparent(
      param(c, 'workspaceId'),
      c.req.valid('param').blockId,
      c.req.valid('json'),
      // Dragging a task into a service homed on another workspace re-points it at that
      // workspace's merge presets, which is the same policy decision a patch makes and is
      // judged against the mover's own tier (ADR 0037).
      blockEditAuthority(c),
      c.req.header('x-connection-id') ?? null,
    )
    return c.json(block, 200)
  })

  // Border-drag resize. Its own route rather than a `position` + `size` patch because a
  // north/west drag moves the container's content origin, and only an operation that sees both
  // halves can keep the contents visually still (see `BoardService.resizeBlock`).
  buildHonoRoute(app, resizeBlockContract, async (c) => {
    const block = await c.get('container').boardService.resizeBlock(
      param(c, 'workspaceId'),
      c.req.valid('param').blockId,
      c.req.valid('json'),
      // Same self-echo skip as move: the response carries the authoritative block, so echoing
      // the coarse signal back would re-hydrate the board under a drag that just ended.
      c.req.header('x-connection-id') ?? null,
    )
    return c.json(block, 200)
  })

  buildHonoRoute(app, removeBlockContract, async (c) => {
    const container = c.get('container')
    const workspaceId = param(c, 'workspaceId')
    const blockId = c.req.valid('param').blockId
    // Refuse BEFORE anything is torn down: a service frame still holding unfinished work is
    // archived rather than deleted, and the teardown below is irreversible, so a guard that
    // fired after it would refuse a delete that had already killed the runs it was protecting.
    // The preflight hands back the board list it decided on, so the whole DELETE still pays ONE
    // full board read: the teardown reuses it, and so does the remove.
    const preloaded = await container.boardService.assertRemovable(workspaceId, blockId)
    // Then kill every container and durable driver under the subtree, so deleting a
    // service/module never orphans a container that would idle until its watchdog.
    await container.executionService.teardownForBlockTree(workspaceId, blockId, { preloaded })
    await container.boardService.removeBlock(workspaceId, blockId, { preloaded })
    return c.body(null, 204)
  })

  // Archive a service (hide it + its subtree, restorable with no expiry) — the non-destructive
  // alternative to deleting a service that still has unfinished tasks.
  buildHonoRoute(app, archiveBlockContract, async (c) => {
    const block = await c
      .get('container')
      .boardService.archiveBlock(param(c, 'workspaceId'), c.req.valid('param').blockId)
    return c.json(block, 200)
  })

  buildHonoRoute(app, restoreBlockContract, async (c) => {
    const block = await c
      .get('container')
      .boardService.restoreBlock(param(c, 'workspaceId'), c.req.valid('param').blockId)
    return c.json(block, 200)
  })

  buildHonoRoute(app, toggleDependencyContract, async (c) => {
    const block = await c
      .get('container')
      .boardService.toggleDependency(
        param(c, 'workspaceId'),
        c.req.valid('param').blockId,
        c.req.valid('json').sourceId,
      )
    return c.json(block, 200)
  })

  return app
}
