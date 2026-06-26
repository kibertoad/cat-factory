import type { BrainstormSession, BrainstormSessionRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the brainstorm (structured-dialogue) session store. The brainstorm
// engine (BrainstormService over IterativeReviewService) is runtime-neutral, but each facade
// persists sessions in its own store — D1 on Cloudflare, Drizzle/Postgres on Node. This suite
// drives the SAME upsert → read → delete assertions through whichever real repository a runtime
// hands it, so a column mapped differently or a JSON blob (de)serialised differently fails a
// test instead of shipping. Crucially it pins the one structural departure from the review
// repos: a session is keyed per (block, STAGE), so a block can hold a live `requirements` AND a
// live `architecture` session at once without collision.

function session(
  overrides: Partial<BrainstormSession> & Pick<BrainstormSession, 'id' | 'blockId' | 'stage'>,
): BrainstormSession {
  return {
    status: 'ready',
    items: [
      {
        id: 'i1',
        category: 'question',
        severity: 'high',
        title: 'Which approach?',
        detail: 'Option A vs B with trade-offs',
        status: 'open',
        reply: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    model: 'workers-ai:m',
    convergedDirection: null,
    iteration: 1,
    maxIterations: 6,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link BrainstormSessionRepository} behaves identically to the others.
 * `makeRepo` returns a repo over the runtime's real store; ids are unique per run so the shared
 * database stays isolated between cases.
 */
export function defineBrainstormSuite(
  name: string,
  makeRepo: () => BrainstormSessionRepository,
): void {
  describe(`[${name}] brainstorm session repository parity`, () => {
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { ws: `ws-${tag}`, block: `blk-${tag}` }
    }

    it('round-trips a session by id and by (block, stage), preserving items + the direction', async () => {
      const repo = makeRepo()
      const { ws, block } = ids()
      const s = session({
        id: `${ws}-r`,
        blockId: block,
        stage: 'requirements',
        status: 'incorporated',
        convergedDirection: '# Direction\nbuild X',
      })
      await repo.upsert(ws, s)

      const byStage = await repo.getByBlockStage(ws, block, 'requirements')
      expect(byStage).not.toBeNull()
      expect(byStage!.id).toBe(s.id)
      expect(byStage!.stage).toBe('requirements')
      expect(byStage!.status).toBe('incorporated')
      expect(byStage!.convergedDirection).toBe('# Direction\nbuild X')
      expect(byStage!.items).toEqual(s.items)

      const byId = await repo.get(ws, s.id)
      expect(byId!.blockId).toBe(block)
    })

    it('keeps a requirements and an architecture session for one block isolated', async () => {
      const repo = makeRepo()
      const { ws, block } = ids()
      await repo.upsert(
        ws,
        session({
          id: `${ws}-req`,
          blockId: block,
          stage: 'requirements',
          convergedDirection: 'REQ',
        }),
      )
      await repo.upsert(
        ws,
        session({
          id: `${ws}-arch`,
          blockId: block,
          stage: 'architecture',
          convergedDirection: 'ARCH',
        }),
      )

      expect((await repo.getByBlockStage(ws, block, 'requirements'))!.convergedDirection).toBe(
        'REQ',
      )
      expect((await repo.getByBlockStage(ws, block, 'architecture'))!.convergedDirection).toBe(
        'ARCH',
      )

      // Deleting one stage leaves the other intact.
      await repo.deleteByBlockStage(ws, block, 'requirements')
      expect(await repo.getByBlockStage(ws, block, 'requirements')).toBeNull()
      expect((await repo.getByBlockStage(ws, block, 'architecture'))!.convergedDirection).toBe(
        'ARCH',
      )
    })

    it('upsert replaces an existing session in place', async () => {
      const repo = makeRepo()
      const { ws, block } = ids()
      const s = session({ id: `${ws}-u`, blockId: block, stage: 'architecture' })
      await repo.upsert(ws, s)
      await repo.upsert(ws, {
        ...s,
        status: 'incorporated',
        convergedDirection: 'FINAL',
        updatedAt: 2,
      })
      const got = await repo.getByBlockStage(ws, block, 'architecture')
      expect(got!.status).toBe('incorporated')
      expect(got!.convergedDirection).toBe('FINAL')
    })
  })
}
