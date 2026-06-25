import type { Block } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  canReparent,
  dependenciesMet,
  epicMembers,
  unmetDependencies,
  wouldCreateCycle,
} from './board.logic.js'

// Minimal block factory — only the fields the dependency-graph helpers read.
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
    level: 'task',
    parentId: null,
    ...over,
  }
}

describe('wouldCreateCycle', () => {
  it('rejects an edge that closes a cycle', () => {
    // a dependsOn b ; adding b dependsOn a would cycle.
    const blocks = [block('a', { dependsOn: ['b'] }), block('b')]
    expect(wouldCreateCycle(blocks, 'b', 'a')).toBe(true)
  })

  it('allows an edge that keeps the graph acyclic', () => {
    const blocks = [block('a'), block('b'), block('c')]
    expect(wouldCreateCycle(blocks, 'a', 'b')).toBe(false)
  })

  it('detects a transitive cycle', () => {
    // a -> b -> c ; adding c dependsOn a closes the loop.
    const blocks = [block('a', { dependsOn: ['b'] }), block('b', { dependsOn: ['c'] }), block('c')]
    expect(wouldCreateCycle(blocks, 'c', 'a')).toBe(true)
  })

  it('treats a self-edge as not-a-cycle (rejected separately)', () => {
    expect(wouldCreateCycle([block('a')], 'a', 'a')).toBe(false)
  })
})

describe('dependenciesMet / unmetDependencies', () => {
  it('is met when all dependencies are done', () => {
    const blocks = [
      block('t', { dependsOn: ['a', 'b'] }),
      block('a', { status: 'done' }),
      block('b', { status: 'done' }),
    ]
    expect(dependenciesMet(blocks, 't')).toBe(true)
    expect(unmetDependencies(blocks, 't')).toEqual([])
  })

  it('is unmet while any dependency is not done', () => {
    const blocks = [
      block('t', { dependsOn: ['a', 'b'] }),
      block('a', { status: 'done' }),
      block('b', { status: 'in_progress' }),
    ]
    expect(dependenciesMet(blocks, 't')).toBe(false)
    expect(unmetDependencies(blocks, 't').map((b) => b.id)).toEqual(['b'])
  })

  it('treats a missing dependency block as satisfied (never blocks forever)', () => {
    const blocks = [block('t', { dependsOn: ['gone'] })]
    expect(dependenciesMet(blocks, 't')).toBe(true)
  })

  it('a task with no dependencies is always met', () => {
    expect(dependenciesMet([block('t')], 't')).toBe(true)
  })
})

describe('epicMembers', () => {
  it('returns tasks linked to the epic via epicId', () => {
    const blocks = [
      block('e', { level: 'epic' }),
      block('t1', { epicId: 'e' }),
      block('t2', { epicId: 'e' }),
      block('t3', { epicId: 'other' }),
      block('t4'),
    ]
    expect(epicMembers(blocks, 'e').map((b) => b.id)).toEqual(['t1', 't2'])
  })
})

describe('canReparent with epics', () => {
  it('allows an epic under a frame or module, but nothing into an epic', () => {
    const frame = block('f', { level: 'frame' })
    const module = block('m', { level: 'module' })
    const epic = block('e', { level: 'epic' })
    expect(canReparent('epic', frame)).toBe(true)
    expect(canReparent('epic', module)).toBe(true)
    expect(canReparent('task', epic)).toBe(false)
    expect(canReparent('module', epic)).toBe(false)
  })
})
