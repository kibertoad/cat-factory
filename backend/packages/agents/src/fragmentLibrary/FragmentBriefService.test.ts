import type {
  FragmentBriefGenerator,
  FragmentBriefRecord,
  FragmentBriefRepository,
  FragmentOwnerKind,
  ResolvedCatalogEntry,
} from '@cat-factory/kernel'
import { FRAGMENT_BRIEF_MIN_BODY_CHARS, createRecordingLogger } from '@cat-factory/kernel'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FragmentBriefService } from './FragmentBriefService.js'

// Every assertion here is about ONE property: a standard's condensed variant is an
// optimisation of how it is STATED, so no failure on this path may change what an
// implementer is held to. Every degradation therefore lands on "fold the full body".

const LONG_BODY = `Never block the event loop. ${'Detail. '.repeat(FRAGMENT_BRIEF_MIN_BODY_CHARS / 8)}`
const SHORT_BODY = 'Keep handlers small.'

function entry(over: Partial<ResolvedCatalogEntry> = {}): ResolvedCatalogEntry {
  return {
    id: 'org.standard',
    version: '1.0.0',
    title: 'Org standard',
    category: null,
    summary: 'A standard',
    body: LONG_BODY,
    brief: null,
    briefScope: { ownerKind: 'workspace', ownerId: 'ws1' },
    appliesTo: null,
    tags: null,
    source: null,
    documentRef: null,
    docViaWorkspaceId: null,
    resolvedAt: null,
    tier: 'workspace',
    ...over,
  }
}

class FakeBriefRepository implements FragmentBriefRepository {
  rows: FragmentBriefRecord[] = []
  listCalls: Array<[FragmentOwnerKind, string]> = []
  listFails = false

  async listByOwner(ownerKind: FragmentOwnerKind, ownerId: string): Promise<FragmentBriefRecord[]> {
    this.listCalls.push([ownerKind, ownerId])
    if (this.listFails) throw new Error('store down')
    return this.rows.filter((r) => r.ownerKind === ownerKind && r.ownerId === ownerId)
  }

  async upsert(record: FragmentBriefRecord): Promise<void> {
    this.rows = this.rows.filter(
      (r) =>
        !(
          r.ownerKind === record.ownerKind &&
          r.ownerId === record.ownerId &&
          r.fragmentId === record.fragmentId
        ),
    )
    this.rows.push(record)
  }

  async delete(ownerKind: FragmentOwnerKind, ownerId: string, fragmentId: string): Promise<void> {
    this.rows = this.rows.filter(
      (r) => !(r.ownerKind === ownerKind && r.ownerId === ownerId && r.fragmentId === fragmentId),
    )
  }
}

function fakeGenerator(over: Partial<FragmentBriefGenerator> = {}): FragmentBriefGenerator {
  return {
    enabled: true,
    generate: vi.fn(
      async () => ({ outcome: 'brief', brief: 'Terse restatement.', model: 'fake:small' }) as const,
    ),
    ...over,
  }
}

let repo: FakeBriefRepository

beforeEach(() => {
  repo = new FakeBriefRepository()
})

function service(
  generator?: FragmentBriefGenerator,
  logger?: ReturnType<typeof createRecordingLogger>,
) {
  return new FragmentBriefService({
    repository: repo,
    ...(generator ? { generator } : {}),
    clock: { now: () => 1_000 },
    ...(logger ? { logger } : {}),
  })
}

describe('FragmentBriefService.resolveBriefs', () => {
  it('folds an authored brief without reading the store or calling a model', async () => {
    const generator = fakeGenerator()
    const briefs = await service(generator).resolveBriefs('ws1', [
      { entry: entry({ brief: 'Linked short version.' }), body: LONG_BODY },
    ])
    expect(briefs.get('org.standard')).toBe('Linked short version.')
    expect(repo.listCalls).toEqual([])
    expect(generator.generate).not.toHaveBeenCalled()
  })

  it('leaves a short standard with no brief, so its full body is folded', async () => {
    const generator = fakeGenerator()
    const briefs = await service(generator).resolveBriefs('ws1', [
      { entry: entry({ body: SHORT_BODY }), body: SHORT_BODY },
    ])
    expect(briefs.size).toBe(0)
    expect(generator.generate).not.toHaveBeenCalled()
  })

  it('generates, persists and folds a brief for a long standard with none', async () => {
    const generator = fakeGenerator()
    const briefs = await service(generator).resolveBriefs('ws1', [
      { entry: entry(), body: LONG_BODY },
    ])
    expect(briefs.get('org.standard')).toBe('Terse restatement.')
    expect(repo.rows).toMatchObject([
      { ownerKind: 'workspace', ownerId: 'ws1', fragmentId: 'org.standard', model: 'fake:small' },
    ])
    expect(generator.generate).toHaveBeenCalledWith('ws1', {
      title: 'Org standard',
      body: LONG_BODY,
      summary: 'A standard',
    })
  })

  it('reuses the persisted brief on the next dispatch — the condensation is paid for once', async () => {
    const generator = fakeGenerator()
    const svc = service(generator)
    await svc.resolveBriefs('ws1', [{ entry: entry(), body: LONG_BODY }])
    const briefs = await svc.resolveBriefs('ws1', [{ entry: entry(), body: LONG_BODY }])
    expect(briefs.get('org.standard')).toBe('Terse restatement.')
    expect(generator.generate).toHaveBeenCalledTimes(1)
  })

  it('REGENERATES when the source body changed underneath the stored brief', async () => {
    const generator = fakeGenerator()
    const svc = service(generator)
    await svc.resolveBriefs('ws1', [{ entry: entry(), body: LONG_BODY }])

    // The living-document case: the same fragment, re-resolved to a NEW body at run time.
    const moved = `${LONG_BODY} And one more rule that must survive.`
    ;(generator.generate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      brief: 'Terse restatement, including the new rule.',
      model: 'fake:small',
    })
    const briefs = await svc.resolveBriefs('ws1', [{ entry: entry({ body: moved }), body: moved }])

    expect(briefs.get('org.standard')).toBe('Terse restatement, including the new rule.')
    expect(generator.generate).toHaveBeenCalledTimes(2)
    expect(repo.rows).toHaveLength(1) // replaced, not accumulated
  })

  it('reads each owner scope ONCE, however many standards share it', async () => {
    const generator = fakeGenerator()
    await service(generator).resolveBriefs('ws1', [
      { entry: entry({ id: 'a' }), body: LONG_BODY },
      { entry: entry({ id: 'b' }), body: LONG_BODY },
      {
        entry: entry({
          id: 'c',
          tier: 'builtin',
          briefScope: { ownerKind: 'account', ownerId: 'acc1' },
        }),
        body: LONG_BODY,
      },
    ])
    // Two distinct scopes, three standards — never a point read per fragment.
    expect(repo.listCalls).toEqual([
      ['workspace', 'ws1'],
      ['account', 'acc1'],
    ])
  })

  it('scopes a built-in standard to the ACCOUNT, so sibling boards reuse one condensation', async () => {
    const generator = fakeGenerator()
    const builtin = entry({
      id: 'node.performance',
      tier: 'builtin',
      briefScope: { ownerKind: 'account', ownerId: 'acc1' },
    })
    const svc = service(generator)
    await svc.resolveBriefs('ws1', [{ entry: builtin, body: LONG_BODY }])
    await svc.resolveBriefs('ws2', [{ entry: builtin, body: LONG_BODY }])
    expect(generator.generate).toHaveBeenCalledTimes(1)
    expect(repo.rows).toMatchObject([{ ownerKind: 'account', ownerId: 'acc1' }])
  })

  it('hands the RUN to the generator, so its model call is attributed to the paying step', async () => {
    // A condensation is a model call on the run path. It reaches `llm_call_metrics` through the
    // generator's own `ModelScope`, which is built from this id — so dropping it anywhere along
    // AgentContextBuilder → resolveBodiesForRun → here → the generator files the call under a
    // null execution id: in the store, absent from the step's rollup, reading as spend that
    // never happened. Nothing about that fails loudly, hence this assertion.
    const generator = fakeGenerator()
    await service(generator).resolveBriefs('ws1', [{ entry: entry(), body: LONG_BODY }], {
      executionId: 'exec_1',
    })
    expect(generator.generate).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({ executionId: 'exec_1' }),
    )
  })

  it('leaves the run unnamed for a caller that has none', async () => {
    // The honest answer, not a guess: an off-run caller's condensation is unattributed.
    const generator = fakeGenerator()
    await service(generator).resolveBriefs('ws1', [{ entry: entry(), body: LONG_BODY }])
    expect(generator.generate).toHaveBeenCalledWith(
      'ws1',
      expect.not.objectContaining({ executionId: expect.anything() }),
    )
  })

  it('folds the full body when no generator is wired', async () => {
    const briefs = await service().resolveBriefs('ws1', [{ entry: entry(), body: LONG_BODY }])
    expect(briefs.size).toBe(0)
    expect(repo.rows).toEqual([])
  })

  it('folds the full body when the generator is present but disabled', async () => {
    const generator = fakeGenerator({ enabled: false })
    const briefs = await service(generator).resolveBriefs('ws1', [
      { entry: entry(), body: LONG_BODY },
    ])
    expect(briefs.size).toBe(0)
    expect(generator.generate).not.toHaveBeenCalled()
  })

  it('folds the full body and REPORTS when a condensation fails', async () => {
    const logger = createRecordingLogger()
    const generator = fakeGenerator({
      generate: vi.fn(async () => {
        throw new Error('model refused')
      }),
    })
    const briefs = await service(generator, logger).resolveBriefs('ws1', [
      { entry: entry(), body: LONG_BODY },
    ])
    expect(briefs.size).toBe(0)
    expect(repo.rows).toEqual([])
    expect(logger.lines.some((l) => l.msg.includes('fragment brief generation'))).toBe(true)
  })

  it('does not re-condense the whole catalog when the STORE is unreadable', async () => {
    // An outage must not read as "nothing has ever been generated" — that would spend a
    // condensation per standard per dispatch for as long as the store is down.
    const logger = createRecordingLogger()
    const generator = fakeGenerator()
    repo.listFails = true
    const briefs = await service(generator, logger).resolveBriefs('ws1', [
      { entry: entry(), body: LONG_BODY },
    ])
    expect(briefs.size).toBe(0)
    expect(generator.generate).not.toHaveBeenCalled()
    expect(logger.lines.some((l) => l.msg.includes('fragment brief load'))).toBe(true)
  })

  it('one failed condensation does not lose the ones that succeeded', async () => {
    const generator = fakeGenerator({
      generate: vi.fn(async (_ws: string, input: { title: string }) => {
        if (input.title === 'Bad') throw new Error('model refused')
        return { outcome: 'brief', brief: 'Terse.', model: 'fake:small' } as const
      }),
    })
    const briefs = await service(generator, createRecordingLogger()).resolveBriefs('ws1', [
      { entry: entry({ id: 'good', title: 'Good' }), body: LONG_BODY },
      { entry: entry({ id: 'bad', title: 'Bad' }), body: LONG_BODY },
    ])
    expect(briefs.get('good')).toBe('Terse.')
    expect(briefs.has('bad')).toBe(false)
  })

  // ---- a standard that cannot be usefully condensed -----------------------------------
  // The generator is told to return the text near its original length rather than drop a
  // rule, so "not condensable" is an ORDINARY outcome — and it is the one that hits the
  // longest standards, which are exactly the ones this feature exists for. It must be
  // remembered, or those standards re-pay for a model call on every implementer dispatch.

  const notCondensable = () =>
    fakeGenerator({
      generate: vi.fn(
        async () =>
          ({ outcome: 'not-condensable', model: 'fake:small', reason: 'no shorter' }) as const,
      ),
    })

  it('RECORDS a refusal against the body, so the next dispatch does not re-ask', async () => {
    const generator = notCondensable()
    const logger = createRecordingLogger()
    const svc = service(generator, logger)

    const first = await svc.resolveBriefs('ws1', [{ entry: entry(), body: LONG_BODY }])
    expect(first.size).toBe(0)
    expect(generator.generate).toHaveBeenCalledTimes(1)
    // A row exists and carries the marker plus the fingerprint of the body it refused.
    expect(repo.rows).toHaveLength(1)
    expect(repo.rows[0]?.brief).toBe('')
    expect(repo.rows[0]?.model).toBe('fake:small')

    const second = await svc.resolveBriefs('ws1', [{ entry: entry(), body: LONG_BODY }])
    expect(second.size).toBe(0)
    expect(generator.generate).toHaveBeenCalledTimes(1)
    // Silence would read as "the feature is on" while every implementer gets full bodies.
    expect(logger.lines.some((l) => l.msg.includes('not condensable'))).toBe(true)
  })

  it('re-attempts once the standard itself is rewritten', async () => {
    // The marker is scoped to a BODY, so a curator who edits the standard gets a fresh
    // attempt with no manual reset and no operator surface.
    const generator = notCondensable()
    const svc = service(generator, createRecordingLogger())
    await svc.resolveBriefs('ws1', [{ entry: entry(), body: LONG_BODY }])
    expect(generator.generate).toHaveBeenCalledTimes(1)

    await svc.resolveBriefs('ws1', [{ entry: entry(), body: `${LONG_BODY} Also: measure first.` }])
    expect(generator.generate).toHaveBeenCalledTimes(2)
  })

  it('does NOT record a marker when the generator throws', async () => {
    // The distinction the port exists for: a provider blip must be retried, never remembered
    // as "this standard cannot be condensed" — that would disable the feature for a fragment
    // on the strength of one bad minute.
    const generator = fakeGenerator({
      generate: vi.fn(async () => {
        throw new Error('provider unreachable')
      }),
    })
    const svc = service(generator, createRecordingLogger())
    await svc.resolveBriefs('ws1', [{ entry: entry(), body: LONG_BODY }])
    expect(repo.rows).toEqual([])

    await svc.resolveBriefs('ws1', [{ entry: entry(), body: LONG_BODY }])
    expect(generator.generate).toHaveBeenCalledTimes(2)
  })

  it('lets a curator override a recorded refusal by linking their own brief', async () => {
    const generator = notCondensable()
    const svc = service(generator, createRecordingLogger())
    await svc.resolveBriefs('ws1', [{ entry: entry(), body: LONG_BODY }])

    const briefs = await svc.resolveBriefs('ws1', [
      { entry: entry({ brief: 'Hand-written.' }), body: LONG_BODY },
    ])
    expect(briefs.get('org.standard')).toBe('Hand-written.')
    expect(generator.generate).toHaveBeenCalledTimes(1)
  })
})

describe('FragmentBriefService.forget', () => {
  it('drops the derived row so it cannot outlive the standard it condensed', async () => {
    const svc = service(fakeGenerator())
    await svc.resolveBriefs('ws1', [{ entry: entry(), body: LONG_BODY }])
    await svc.forget('workspace', 'ws1', 'org.standard')
    expect(repo.rows).toEqual([])
  })

  it('never propagates a delete failure into the removal a curator asked for', async () => {
    repo.delete = async () => {
      throw new Error('store down')
    }
    await expect(
      service(fakeGenerator(), createRecordingLogger()).forget('workspace', 'ws1', 'org.standard'),
    ).resolves.toBeUndefined()
  })
})
