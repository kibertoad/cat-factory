import { describe, expect, it } from 'vitest'
import type {
  AcceptanceCriterionRecord,
  AcceptanceCriterionRepository,
  Block,
  BlockRepository,
} from '@cat-factory/kernel'
import { ACCEPTANCE_CRITERIA_MAX_PER_FRAME } from '@cat-factory/contracts'
import { AcceptanceCriteriaService } from './AcceptanceCriteriaService.js'

// The ACCRETION half of the acceptance-criteria store (see
// docs/initiatives/acceptance-criteria-store.md). The cross-runtime conformance suite covers the
// CRUD surface + the `proposed`/`retired` prompt gating against real databases; what it cannot
// cover is this — the extraction pass needs a wired model provider, which the conformance harness
// has none of. So the dedupe / capacity / replay behaviour is pinned here, over a fake repository,
// where the drafts can be handed in directly.
//
// These are the rules a regression would break SILENTLY: nothing throws when dedupe stops working,
// the triage list just fills with duplicates until a human stops using the feature.

const FRAME = 'blk_frame'
const WS = 'ws_1'

function fakeRepo(seed: AcceptanceCriterionRecord[] = []) {
  const rows = new Map(seed.map((r) => [r.id, r]))
  const repo: AcceptanceCriterionRepository & { rows: Map<string, AcceptanceCriterionRecord> } = {
    rows,
    async get(workspaceId, id) {
      const row = rows.get(id)
      return row && row.workspaceId === workspaceId ? row : null
    },
    async listByFrameBlocks(workspaceId, blockIds) {
      return [...rows.values()].filter(
        (r) => r.workspaceId === workspaceId && blockIds.includes(r.blockId),
      )
    },
    async listByWorkspace(workspaceId) {
      return [...rows.values()].filter((r) => r.workspaceId === workspaceId)
    },
    async upsertMany(records) {
      for (const record of records) rows.set(record.id, record)
    },
    async delete(workspaceId, id) {
      const row = rows.get(id)
      if (row?.workspaceId === workspaceId) rows.delete(id)
    },
    async deleteByBlocks(workspaceId, blockIds) {
      for (const [id, row] of rows) {
        if (row.workspaceId === workspaceId && blockIds.includes(row.blockId)) rows.delete(id)
      }
    },
  }
  return repo
}

const frameBlock = { id: FRAME, level: 'frame', title: 'Auth' } as unknown as Block

function fakeBlocks(block: Block | null = frameBlock): BlockRepository {
  return {
    async get() {
      return block
    },
  } as unknown as BlockRepository
}

function makeService(repo: AcceptanceCriterionRepository, blocks = fakeBlocks()) {
  let n = 0
  return new AcceptanceCriteriaService({
    acceptanceCriterionRepository: repo,
    blockRepository: blocks,
    idGenerator: { next: (prefix: string) => `${prefix}_${++n}` },
    clock: { now: () => 1_000 },
  })
}

const draft = (
  title: string,
  over: Partial<Record<'given' | 'when' | 'outcome', string>> = {},
) => ({
  title,
  given: over.given ?? '',
  when: over.when ?? 'the token is presented',
  outcome: over.outcome ?? 'the request is rejected with 401',
  tags: [],
})

function derivedRow(id: string, title: string, sourceReviewId: string): AcceptanceCriterionRecord {
  return {
    id,
    workspaceId: WS,
    blockId: FRAME,
    title,
    given: '',
    when: 'x',
    outcome: 'y',
    tags: [],
    status: 'proposed',
    provenance: 'derived',
    sourceReviewId,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('AcceptanceCriteriaService.recordDerived', () => {
  it('files usable drafts as proposed, and drops the ones nothing could verify', async () => {
    const repo = fakeRepo()
    const added = await makeService(repo).recordDerived(WS, FRAME, 'rrv_1', [
      draft('Expired sessions are rejected'),
      // No outcome ⇒ unverifiable ⇒ it could never earn a tester verdict, so it is dropped
      // rather than left in a human's triage list as something they can only delete.
      { ...draft('Something happens'), outcome: '   ' },
      { ...draft('   '), when: 'anything' },
    ])
    expect(added).toHaveLength(1)
    expect(added[0]?.title).toBe('Expired sessions are rejected')
    // NEVER `confirmed`: a model extraction no human has read must not steer an agent.
    expect(added[0]?.status).toBe('proposed')
    expect(added[0]?.provenance).toBe('derived')
    expect(added[0]?.sourceReviewId).toBe('rrv_1')
  })

  it('drops a draft whose normalised title already exists, whatever that row’s status', async () => {
    // A retired row is the sharp case: re-proposing something a human decided against is a
    // treadmill, and it is exactly what an extraction pass will try to do every single run.
    const repo = fakeRepo([
      { ...derivedRow('ac_old', 'Expired sessions are rejected!', 'rrv_0'), status: 'retired' },
    ])
    const added = await makeService(repo).recordDerived(WS, FRAME, 'rrv_1', [
      draft('  expired   sessions ARE rejected  '),
      draft('Refresh tokens rotate'),
    ])
    expect(added.map((c) => c.title)).toEqual(['Refresh tokens rotate'])
  })

  it('drops a duplicate WITHIN one extraction batch', async () => {
    // The model does this whenever a document repeats a requirement in two sections.
    const added = await makeService(fakeRepo()).recordDerived(WS, FRAME, 'rrv_1', [
      draft('Expired sessions are rejected'),
      draft('Expired sessions are rejected'),
    ])
    expect(added).toHaveLength(1)
  })

  it('refuses to re-accrete for a review it has already written for (the replay guard)', async () => {
    // Settlement runs inside the durable driver, whose steps replay. Without this a replay adds
    // a second batch of near-identical criteria whose titles happened to differ slightly.
    const repo = fakeRepo([derivedRow('ac_old', 'Expired sessions are rejected', 'rrv_1')])
    const service = makeService(repo)
    expect(await service.hasDerivedFrom(WS, FRAME, 'rrv_1')).toBe(true)
    expect(await service.hasDerivedFrom(WS, FRAME, 'rrv_2')).toBe(false)
    const added = await service.recordDerived(WS, FRAME, 'rrv_1', [draft('Something entirely new')])
    expect(added).toEqual([])
  })

  it('fills only the room left under the per-frame ceiling, and adds nothing when full', async () => {
    const seed = Array.from({ length: ACCEPTANCE_CRITERIA_MAX_PER_FRAME - 1 }, (_, i) =>
      derivedRow(`ac_${i}`, `Existing ${i}`, 'rrv_0'),
    )
    const service = makeService(fakeRepo(seed))
    const added = await service.recordDerived(WS, FRAME, 'rrv_1', [
      draft('First new'),
      draft('Second new'),
    ])
    expect(added.map((c) => c.title)).toEqual(['First new'])

    const full = makeService(fakeRepo([...seed, derivedRow('ac_last', 'Existing last', 'rrv_0')]))
    expect(await full.recordDerived(WS, FRAME, 'rrv_2', [draft('No room')])).toEqual([])
  })
})

describe('AcceptanceCriteriaService resolution + cleanup', () => {
  it('resolves ONLY confirmed criteria, and nothing at all when there are none', async () => {
    const repo = fakeRepo([
      { ...derivedRow('ac_p', 'Proposed', 'rrv_1'), status: 'proposed' },
      { ...derivedRow('ac_r', 'Retired', 'rrv_1'), status: 'retired' },
    ])
    const service = makeService(repo)
    // `null`, not an empty list: the engine spreads the result onto the run context, so this is
    // what keeps a prompt byte-for-byte identical to the pre-feature one.
    expect(await service.resolveForFrame(WS, FRAME)).toBeNull()

    await repo.upsertMany([{ ...derivedRow('ac_c', 'Confirmed', 'rrv_1'), status: 'confirmed' }])
    expect((await service.resolveForFrame(WS, FRAME))?.criteria.map((c) => c.title)).toEqual([
      'Confirmed',
    ])
  })

  it('drops a deleted frame’s criteria in one batched call', async () => {
    const repo = fakeRepo([
      derivedRow('ac_1', 'One', 'rrv_1'),
      { ...derivedRow('ac_2', 'Two', 'rrv_1'), blockId: 'blk_other' },
    ])
    await makeService(repo).deleteForFrames(WS, [FRAME])
    expect([...repo.rows.keys()]).toEqual(['ac_2'])
  })

  it('refuses to store criteria on a non-frame block', async () => {
    const task = { id: 'blk_task', level: 'task', title: 'A task' } as unknown as Block
    const service = makeService(fakeRepo(), fakeBlocks(task))
    // Resolution only ever walks UP to the service frame, so a criterion stored on a task would
    // look saved and then silently never reach a prompt.
    await expect(
      service.create(WS, 'blk_task', { title: 'x', when: 'y', outcome: 'z' }),
    ).rejects.toThrow(/service frame/i)
  })
})
