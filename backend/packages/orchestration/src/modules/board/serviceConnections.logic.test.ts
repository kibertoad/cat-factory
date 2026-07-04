import { connectionNeighborIds } from '@cat-factory/contracts'
import type { Block } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { involvedServiceIdsError, serviceConnectionsError } from './board.logic.js'

// Minimal block factory — only the fields the connection helpers read.
function block(id: string, over: Partial<Block> = {}): Block {
  return {
    id,
    title: id,
    type: 'service',
    description: '',
    position: { x: 0, y: 0 },
    status: 'planned',
    progress: 0,
    dependsOn: [],
    executionId: null,
    level: 'frame',
    parentId: null,
    ...over,
  }
}

function resolveFrom(blocks: Block[]) {
  const byId = new Map(blocks.map((b) => [b.id, b]))
  return (id: string) => byId.get(id)
}

describe('serviceConnectionsError', () => {
  it('accepts connections to other service frames', () => {
    const blocks = [block('a'), block('b')]
    const error = serviceConnectionsError(
      'a',
      [{ serviceBlockId: 'b', description: 'sends email via it' }],
      resolveFrom(blocks),
    )
    expect(error).toBeNull()
  })

  it('rejects a self-connection', () => {
    expect(
      serviceConnectionsError('a', [{ serviceBlockId: 'a' }], resolveFrom([block('a')])),
    ).toMatch(/itself/)
  })

  it('rejects a duplicate target', () => {
    const blocks = [block('a'), block('b')]
    const error = serviceConnectionsError(
      'a',
      [{ serviceBlockId: 'b' }, { serviceBlockId: 'b' }],
      resolveFrom(blocks),
    )
    expect(error).toMatch(/Duplicate/)
  })

  it('rejects a missing target', () => {
    expect(
      serviceConnectionsError('a', [{ serviceBlockId: 'gone' }], resolveFrom([block('a')])),
    ).toMatch(/does not exist/)
  })

  it('rejects a non-frame target', () => {
    const blocks = [block('a'), block('t', { level: 'task' })]
    expect(serviceConnectionsError('a', [{ serviceBlockId: 't' }], resolveFrom(blocks))).toMatch(
      /not a service/,
    )
  })

  it('rejects a non-service frame target (frontends bind via backendBindings)', () => {
    const blocks = [block('a'), block('f', { type: 'frontend' })]
    expect(serviceConnectionsError('a', [{ serviceBlockId: 'f' }], resolveFrom(blocks))).toMatch(
      /not a service/,
    )
  })

  it('allows a cycle: mutual connections between two services are legal', () => {
    const blocks = [block('a', { serviceConnections: [{ serviceBlockId: 'b' }] }), block('b')]
    // b connecting back to a completes the A↔B cycle — fine by design.
    expect(serviceConnectionsError('b', [{ serviceBlockId: 'a' }], resolveFrom(blocks))).toBeNull()
  })
})

describe('connectionNeighborIds', () => {
  it('includes both outgoing targets and frames pointing at this one', () => {
    const blocks = [
      block('a', { serviceConnections: [{ serviceBlockId: 'b' }] }),
      block('b'),
      block('c', { serviceConnections: [{ serviceBlockId: 'a' }] }),
    ]
    expect(connectionNeighborIds(blocks, 'a')).toEqual(new Set(['b', 'c']))
    expect(connectionNeighborIds(blocks, 'b')).toEqual(new Set(['a']))
  })

  it('never includes the frame itself, even on a (bad) self-edge', () => {
    const blocks = [block('a', { serviceConnections: [{ serviceBlockId: 'a' }] })]
    expect(connectionNeighborIds(blocks, 'a').size).toBe(0)
  })
})

describe('involvedServiceIdsError', () => {
  const board = () => {
    const frame = block('own', { serviceConnections: [{ serviceBlockId: 'provider' }] })
    const provider = block('provider')
    const consumer = block('consumer', { serviceConnections: [{ serviceBlockId: 'own' }] })
    const unrelated = block('unrelated')
    const task = block('task', { level: 'task', parentId: 'own' })
    return { blocks: [frame, provider, consumer, unrelated, task], task }
  }

  it('accepts neighbors in EITHER direction (provider and consumer of the own frame)', () => {
    const { blocks, task } = board()
    expect(involvedServiceIdsError(blocks, task, ['provider', 'consumer'])).toBeNull()
  })

  it('rejects an unconnected service', () => {
    const { blocks, task } = board()
    expect(involvedServiceIdsError(blocks, task, ['unrelated'])).toMatch(/not connected/)
  })

  it("rejects the task's own service frame", () => {
    const { blocks, task } = board()
    expect(involvedServiceIdsError(blocks, task, ['own'])).toMatch(/own service/)
  })

  it('rejects duplicates', () => {
    const { blocks, task } = board()
    expect(involvedServiceIdsError(blocks, task, ['provider', 'provider'])).toMatch(/Duplicate/)
  })

  it('rejects a task outside any service frame', () => {
    const orphan = block('orphan', { level: 'task' })
    expect(involvedServiceIdsError([orphan], orphan, ['provider'])).toMatch(/not inside/)
  })

  it('accepts a task nested under a module of the frame', () => {
    const { blocks } = board()
    const module = block('mod', { level: 'module', parentId: 'own' })
    const nested = block('nested', { level: 'task', parentId: 'mod' })
    expect(involvedServiceIdsError([...blocks, module, nested], nested, ['provider'])).toBeNull()
  })
})
