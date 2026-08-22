import { describe, it, expect, beforeEach } from 'vitest'
import { computed } from 'vue'
import { useExecutionStore } from '~/stores/execution'
import type { ExecutionInstance } from '~/types/domain'

/**
 * Minimal instance shape — the `decisionsByBlock` / `approvalsByBlock` getters only read
 * `id`, `blockId` and each step's `{ decision, approval, agentKind }`, so a cast keeps the
 * fixtures focused on the grouping behaviour rather than the full wire contract.
 */
function instance(id: string, blockId: string, steps: unknown[]): ExecutionInstance {
  return { id, blockId, steps } as unknown as ExecutionInstance
}

describe('execution store gate grouping', () => {
  let store: ReturnType<typeof useExecutionStore>
  beforeEach(() => {
    store = useExecutionStore()
  })

  it('decisionsByBlock groups open (unchosen) decisions by block', () => {
    store.hydrate(
      [
        instance('e1', 'b1', [
          { agentKind: 'coder', decision: { id: 'd1', chosen: null } },
          { agentKind: 'coder', decision: { id: 'd2', chosen: 'yes' } }, // chosen ⇒ excluded
        ]),
        instance('e2', 'b2', [{ agentKind: 'architect', decision: { id: 'd3', chosen: null } }]),
      ],
      'ws1',
    )
    expect(store.decisionsByBlock.get('b1')?.map((d) => d.decision.id)).toEqual(['d1'])
    expect(store.decisionsByBlock.get('b2')?.map((d) => d.decision.id)).toEqual(['d3'])
    expect(store.decisionsByBlock.has('missing')).toBe(false)
  })

  it('approvalsByBlock groups pending approvals by block', () => {
    store.hydrate(
      [
        instance('e1', 'b1', [
          { agentKind: 'merger', approval: { id: 'a1', status: 'pending' } },
          { agentKind: 'merger', approval: { id: 'a2', status: 'approved' } }, // not pending ⇒ excluded
        ]),
      ],
      'ws1',
    )
    expect(store.approvalsByBlock.get('b1')?.map((a) => a.approval.id)).toEqual(['a1'])
    expect(store.approvalsByBlock.get('b2')).toBeUndefined()
  })
})

/** A run fixture carrying the fields the reconcile guards read (`id`, `rev`, `status`). */
function run(id: string, rev: number, status: string): ExecutionInstance {
  return { id, blockId: `blk_${id}`, steps: [], status, rev } as unknown as ExecutionInstance
}

describe('execution store snapshot/event reconcile', () => {
  let store: ReturnType<typeof useExecutionStore>
  beforeEach(() => {
    store = useExecutionStore()
  })

  it('a lagging snapshot cannot regress a run a live event already advanced (REGRESS)', () => {
    store.hydrate([run('e1', 3, 'running')], 'ws1')
    // Live event: the run reached a terminal state (rev 4). It emits nothing further.
    store.upsert(run('e1', 4, 'done'))
    // A snapshot read BEFORE the event resolves after it — same run at the older rev.
    store.hydrate([run('e1', 3, 'running')], 'ws1')
    expect(store.getInstance('e1')?.status).toBe('done')
  })

  it('keeps a live-added run a lagging snapshot never saw (DROP)', () => {
    store.hydrate([run('e1', 1, 'running')], 'ws1')
    store.upsert(run('e2', 1, 'running'))
    store.hydrate([run('e1', 2, 'running')], 'ws1') // stale read: predates e2
    expect(store.getInstance('e2')).toBeTruthy()
    expect(store.getInstance('e1')?.rev).toBe(2)
  })

  it('drops a superseded failed run when a retry replaces it under a new id (same block)', () => {
    // A failed run for a block is cached...
    store.hydrate(
      [{ id: 'e_old', blockId: 'b1', steps: [], status: 'failed', rev: 1 } as never],
      'ws1',
    )
    // ...then a retry mints a FRESH run (new id) for the SAME block and deletes the old one
    // server-side. The post-retry snapshot carries only the new running run.
    store.hydrate(
      [{ id: 'e_new', blockId: 'b1', steps: [], status: 'running', rev: 1 } as never],
      'ws1',
    )
    // The dead predecessor must not linger and shadow the running run in the by-block projection.
    expect(store.getInstance('e_old')).toBeUndefined()
    expect(store.getInstance('e_new')?.status).toBe('running')
    expect(store.getByBlock('b1')?.id).toBe('e_new')
  })

  it('keeps a live-added running run when a stale snapshot still lists its block predecessor', () => {
    // A retry already minted e_new (running) for b1 — a live event added it to the cache...
    store.hydrate(
      [{ id: 'e_new', blockId: 'b1', steps: [], status: 'running', rev: 1 } as never],
      'ws1',
    )
    // ...but a reconnect resync fetched BEFORE the retry resolves late (under load) and still
    // carries the now-deleted predecessor e_old (failed) for the same block.
    store.hydrate(
      [{ id: 'e_old', blockId: 'b1', steps: [], status: 'failed', rev: 1 } as never],
      'ws1',
    )
    // The live running run must survive — only a TERMINAL cached run is a superseded predecessor.
    expect(store.getInstance('e_new')?.status).toBe('running')
    expect(store.getByBlock('b1')?.id).toBe('e_new')
  })

  it('a workspace switch replaces the cache outright (no cross-board leak)', () => {
    store.hydrate([run('e1', 1, 'running')], 'ws1')
    store.upsert(run('e2', 1, 'running'))
    store.hydrate([run('e3', 1, 'running')], 'ws2')
    expect(store.getInstance('e1')).toBeUndefined()
    expect(store.getInstance('e2')).toBeUndefined()
    expect(store.getInstance('e3')).toBeTruthy()
  })

  it('an out-of-order live event cannot regress a newer cached run; same-rev replaces', () => {
    store.upsert(run('e1', 5, 'done'))
    store.upsert(run('e1', 4, 'running')) // stale event → ignored
    expect(store.getInstance('e1')?.status).toBe('done')
    store.upsert(run('e1', 5, 'failed')) // equal rev → latest event wins
    expect(store.getInstance('e1')?.status).toBe('failed')
  })

  it('treats a missing rev as 0 (legacy rows still hydrate)', () => {
    store.hydrate([{ id: 'e1', blockId: 'b1', steps: [], status: 'running' } as never], 'ws1')
    store.upsert(run('e1', 1, 'done'))
    expect(store.getInstance('e1')?.status).toBe('done')
  })
})

/** A run whose steps carry an (optional) per-step metrics rollup. */
function runWithMetrics(
  id: string,
  rev: number,
  steps: Array<{ agentKind: string; metrics?: { calls: number } | null }>,
): ExecutionInstance {
  return { id, blockId: `blk_${id}`, steps, status: 'running', rev } as unknown as ExecutionInstance
}

describe('execution store metrics preservation (live-only rollup)', () => {
  let store: ReturnType<typeof useExecutionStore>
  beforeEach(() => {
    store = useExecutionStore()
  })

  it('a metric-less running-fold event does not blank the last-known step metrics', () => {
    // A step-boundary emit carried the rollup...
    store.upsert(runWithMetrics('e1', 1, [{ agentKind: 'coder', metrics: { calls: 3 } }]))
    // ...a later progress-only fold (higher rev) omits it — the backend skips the rollup there.
    store.upsert(runWithMetrics('e1', 2, [{ agentKind: 'coder' }]))
    const step = store.getInstance('e1')!.steps[0] as unknown as { metrics?: { calls: number } }
    expect(step.metrics?.calls).toBe(3)
    expect(store.getInstance('e1')?.rev).toBe(2) // the fold still won (progress/subtasks applied)
  })

  it('a fresh rollup overrides the preserved value', () => {
    store.upsert(runWithMetrics('e1', 1, [{ agentKind: 'coder', metrics: { calls: 3 } }]))
    store.upsert(runWithMetrics('e1', 2, [{ agentKind: 'coder' }])) // fold: preserved
    store.upsert(runWithMetrics('e1', 3, [{ agentKind: 'coder', metrics: { calls: 7 } }]))
    const step = store.getInstance('e1')!.steps[0] as unknown as { metrics?: { calls: number } }
    expect(step.metrics?.calls).toBe(7)
  })

  it('does not carry metrics across a reshaped step (agentKind mismatch at the index)', () => {
    store.upsert(runWithMetrics('e1', 1, [{ agentKind: 'coder', metrics: { calls: 3 } }]))
    // A different kind at index 0 must not inherit the coder's rollup.
    store.upsert(runWithMetrics('e1', 2, [{ agentKind: 'reviewer' }]))
    const step = store.getInstance('e1')!.steps[0] as unknown as { metrics?: { calls: number } }
    expect(step.metrics).toBeUndefined()
  })

  it('preserves metrics through a lagging full refresh that omits them (hydrate)', () => {
    // Establish the workspace first (a fresh-workspace hydrate replaces outright by design).
    store.hydrate([runWithMetrics('e1', 1, [{ agentKind: 'coder' }])], 'ws1')
    store.upsert(runWithMetrics('e1', 2, [{ agentKind: 'coder', metrics: { calls: 5 } }]))
    // A snapshot never carries metrics (never persisted); a same-rev refresh must not blank it.
    store.hydrate([runWithMetrics('e1', 2, [{ agentKind: 'coder' }])], 'ws1')
    const step = store.getInstance('e1')!.steps[0] as unknown as { metrics?: { calls: number } }
    expect(step.metrics?.calls).toBe(5)
  })
})

// Regression for the optimistic-echo CLOBBER. `upsert`/`hydrate` are monotonic by `rev`, but an
// action store's echo used to reach into the cached run and assign a step's sub-state directly,
// comparing nothing — so a slow HTTP response overwrote state the stream had already advanced, and
// no later event restored it. `echoAfter` closes that by capturing the run's `rev` before the
// request and re-reading it after.
//
// The fork-decision chat is the case that caught it in CI: `chat` emits the one-message `answering`
// state and then wakes the driver, which appends the reply and emits again. With a canned (no-model)
// reply the two-message thread routinely lands first, and echoing the response dropped the reply
// permanently — a parked run emits nothing more.
describe('execution store echoAfter (optimistic-echo guard)', () => {
  let store: ReturnType<typeof useExecutionStore>
  beforeEach(() => {
    store = useExecutionStore()
  })

  const run = (rev: number, chat: unknown[]): ExecutionInstance =>
    ({
      id: 'e1',
      blockId: 'b1',
      rev,
      currentStep: 0,
      steps: [{ agentKind: 'coder', forkDecision: { status: 'answering', chat } }],
    }) as unknown as ExecutionInstance

  const chatOf = () =>
    (store.getInstance('e1')!.steps[0] as unknown as { forkDecision: { chat: unknown[] } })
      .forkDecision.chat

  it('applies the echo when nothing newer arrived while the request was in flight', () => {
    store.hydrate([run(1, ['human'])], 'ws1')
    return store
      .echoAfter(
        'e1',
        async () => ({ status: 'answering', chat: ['human', 'echoed'] }),
        (state, instance) => {
          ;(instance.steps[0] as unknown as { forkDecision: unknown }).forkDecision = state
        },
      )
      .then(() => expect(chatOf()).toEqual(['human', 'echoed']))
  })

  it('DROPS the echo when the stream delivered a newer revision first', async () => {
    store.hydrate([run(1, ['human'])], 'ws1')
    // The driver's reply lands (rev 2, two messages) while the chat POST is still in flight...
    await store.echoAfter(
      'e1',
      async () => {
        store.upsert(run(2, ['human', 'assistant reply']))
        return { status: 'answering', chat: ['human'] }
      },
      (state, instance) => {
        ;(instance.steps[0] as unknown as { forkDecision: unknown }).forkDecision = state
      },
    )
    // ...so the one-message response must not put the thread back. Unguarded, this was ['human'],
    // the reply was gone, and the "thinking…" bubble spun forever.
    expect(chatOf()).toEqual(['human', 'assistant reply'])
  })

  it('still returns the response body when the echo is dropped', async () => {
    store.hydrate([run(1, [])], 'ws1')
    const returned = await store.echoAfter(
      'e1',
      async () => {
        store.upsert(run(5, ['newer']))
        return 'body'
      },
      () => {
        throw new Error('apply must not run')
      },
    )
    expect(returned).toBe('body')
  })

  it('skips the echo for a run the cache does not hold, rather than throwing', async () => {
    const returned = await store.echoAfter(
      'missing',
      async () => 'body',
      () => {
        throw new Error('apply must not run')
      },
    )
    expect(returned).toBe('body')
  })
})

describe('execution store per-block index', () => {
  let store: ReturnType<typeof useExecutionStore>
  beforeEach(() => {
    store = useExecutionStore()
  })

  /**
   * Named apart from the module-level `run()` on purpose: that one's second argument is a `rev`
   * and this one's is a `blockId`, so one name for both would let a test moved between the two
   * describes build a nonsense instance that still typechecks at the call site.
   */
  function blockRun(id: string, blockId: string, status: string): ExecutionInstance {
    return { id, blockId, status, steps: [] } as unknown as ExecutionInstance
  }

  it('indexes one run per block', () => {
    store.hydrate([blockRun('e1', 'b1', 'running'), blockRun('e2', 'b2', 'done')], 'ws1')
    expect(store.getByBlock('b1')?.id).toBe('e1')
    expect(store.getByBlock('b2')?.id).toBe('e2')
    expect(store.getByBlock('missing')).toBeUndefined()
  })

  // The case the index has to keep answering the way the scan it replaced did: a stale reconnect
  // snapshot re-listing a retry's now-deleted terminal predecessor beside the live successor.
  it('prefers the live run over a terminal predecessor on the same block, in either order', () => {
    store.hydrate([blockRun('old', 'b1', 'failed'), blockRun('new', 'b1', 'running')], 'ws1')
    expect(store.getByBlock('b1')?.id).toBe('new')

    store.hydrate([blockRun('new2', 'b2', 'running'), blockRun('old2', 'b2', 'failed')], 'ws1')
    expect(store.getByBlock('b2')?.id).toBe('new2')
  })

  it('answers the LAST run when a block holds only terminal ones', () => {
    store.hydrate([blockRun('first', 'b1', 'done'), blockRun('second', 'b1', 'failed')], 'ws1')
    expect(store.getByBlock('b1')?.id).toBe('second')
  })

  it('keeps the first live run when a block holds several', () => {
    store.hydrate([blockRun('a', 'b1', 'running'), blockRun('b', 'b1', 'blocked')], 'ws1')
    expect(store.getByBlock('b1')?.id).toBe('a')
  })

  it('re-indexes when an event upserts a run', () => {
    store.hydrate([blockRun('e1', 'b1', 'running')], 'ws1')
    expect(store.getByBlock('b1')?.status).toBe('running')
    store.upsert({ ...blockRun('e1', 'b1', 'done'), rev: 2 } as unknown as ExecutionInstance)
    expect(store.getByBlock('b1')?.status).toBe('done')
  })
})

/**
 * The board snapshot serves a LEAN PROJECTION of every run: each step's captured prose is
 * withheld and the instance says so (`projected`). These pin the reconcile rule that makes a
 * refresh safe to land on top of a run the cache already holds whole.
 */
describe('execution store lean-projection reconcile', () => {
  let store: ReturnType<typeof useExecutionStore>
  beforeEach(() => {
    store = useExecutionStore()
  })

  /** A run whose single step carries prose. */
  function whole(rev: number, output = 'the full prose'): ExecutionInstance {
    return {
      id: 'e1',
      blockId: 'b1',
      status: 'running',
      rev,
      outputHistory: [{ stepIndex: 0, output: 'superseded' }],
      steps: [{ agentKind: 'coder', state: 'done', output }],
    } as unknown as ExecutionInstance
  }

  /** The same run as the snapshot serves it. */
  function projected(rev: number): ExecutionInstance {
    return {
      id: 'e1',
      blockId: 'b1',
      status: 'running',
      rev,
      projected: true,
      steps: [{ agentKind: 'coder', state: 'done', hasOutput: true }],
    } as unknown as ExecutionInstance
  }

  it('carries the withheld prose forward at an equal revision, and stops calling it a projection', () => {
    // The real sequence: a board load, then the live event that carries the whole run, then the
    // next refresh landing the projection again at the revision the event already delivered.
    store.hydrate([projected(4)], 'ws1')
    store.upsert(whole(4))
    store.hydrate([projected(4)], 'ws1')
    const held = store.getInstance('e1')!
    expect(held.steps[0]!.output).toBe('the full prose')
    expect(held.outputHistory).toHaveLength(1)
    expect(held.projected).toBe(false)
  })

  it('does not paste stale prose under a NEWER revision of the run', () => {
    store.hydrate([projected(4)], 'ws1')
    store.upsert(whole(4))
    store.hydrate([projected(5)], 'ws1')
    const held = store.getInstance('e1')!
    expect(held.steps[0]!.output).toBeUndefined()
    expect(held.outputHistory).toBeUndefined()
    // Still marked, so the overlay knows to fetch the whole run rather than read an absence.
    expect(held.projected).toBe(true)
  })

  it('keeps the projection marked when the cache held only a projection too', () => {
    store.hydrate([projected(4)], 'ws1')
    store.hydrate([projected(4)], 'ws1')
    expect(store.getInstance('e1')!.projected).toBe(true)
  })

  it('applies the same carry-forward to a projection arriving through upsert', () => {
    store.hydrate([whole(4)], 'ws1')
    store.upsert(projected(4))
    expect(store.getInstance('e1')!.steps[0]!.output).toBe('the full prose')
  })

  it('leaves a whole run delivered by an event alone', () => {
    store.hydrate([projected(4)], 'ws1')
    store.upsert(whole(5, 'fresh prose'))
    const held = store.getInstance('e1')!
    expect(held.steps[0]!.output).toBe('fresh prose')
    expect(held.projected).toBeUndefined()
  })
})

/**
 * `instances` is a SHALLOW ref, so every write site has to announce itself. A regression here is
 * silent in the product (a card just stops updating), which is why the three write shapes are
 * pinned through a derived value rather than by reading the array back.
 */
describe('execution store shallow-ref write sites', () => {
  let store: ReturnType<typeof useExecutionStore>
  beforeEach(() => {
    store = useExecutionStore()
  })

  function stepRun(id: string, rev: number, output?: string): ExecutionInstance {
    return {
      id,
      blockId: `blk_${id}`,
      status: 'running',
      rev,
      steps: [{ agentKind: 'coder', state: 'done', output }],
    } as unknown as ExecutionInstance
  }

  it('a replace, an index assignment, a push and an in-place echo each invalidate a derived read', async () => {
    const seen = computed(() => store.instances.map((e) => `${e.id}:${e.steps[0]?.output ?? ''}`))

    store.hydrate([stepRun('e1', 1, 'first')], 'ws1')
    expect(seen.value).toEqual(['e1:first'])

    // push
    store.upsert(stepRun('e2', 1, 'other'))
    expect(seen.value).toEqual(['e1:first', 'e2:other'])

    // index assignment
    store.upsert(stepRun('e1', 2, 'second'))
    expect(seen.value).toEqual(['e1:second', 'e2:other'])

    // in-place patch through the one echo seam
    await store.echoAfter(
      'e1',
      () => Promise.resolve('echoed'),
      (state, instance) => {
        instance.steps[0]!.output = state
      },
    )
    expect(seen.value).toEqual(['e1:echoed', 'e2:other'])
  })
})
