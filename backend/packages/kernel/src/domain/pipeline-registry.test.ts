import { describe, expect, it } from 'vitest'
import { defaultPipelineRegistry } from './pipeline-registry.js'
import type { Pipeline } from './types.js'

// `register` and `retire` are opposite assertions about ONE id, and both of them also have to
// merge into a built-in catalog the registry does not own. That interplay is what these pin: a
// registration and a retirement of the same id may never both survive, and neither side may
// mutate the built-in list it was handed.

const pipeline = (id: string, over: Partial<Pipeline> = {}): Pipeline =>
  ({ id, name: id, agentKinds: ['coder'], ...over }) as Pipeline

describe('PipelineRegistry', () => {
  it('keeps registrations in registration order', () => {
    const registry = defaultPipelineRegistry()
    registry.registerMany([pipeline('b'), pipeline('a'), pipeline('c')])
    expect(registry.registered().map((p) => p.id)).toEqual(['b', 'a', 'c'])
  })

  it('re-registering an id replaces it IN PLACE rather than appending a second copy', () => {
    const registry = defaultPipelineRegistry()
    registry.registerMany([pipeline('a'), pipeline('b')])
    registry.register(pipeline('a', { name: 'renamed' }))
    expect(registry.registered().map((p) => p.id)).toEqual(['a', 'b'])
    expect(registry.registered()[0]?.name).toBe('renamed')
  })

  it('hands out a COPY of the registered list, so a caller cannot mutate the registry', () => {
    const registry = defaultPipelineRegistry()
    registry.register(pipeline('a'))
    registry.registered().push(pipeline('smuggled'))
    expect(registry.registered().map((p) => p.id)).toEqual(['a'])
  })

  it('retiring a registered id drops the registration', () => {
    const registry = defaultPipelineRegistry()
    registry.registerMany([pipeline('a'), pipeline('b')])
    registry.retire('a')
    expect(registry.registered().map((p) => p.id)).toEqual(['b'])
    expect(registry.retired()).toEqual([{ id: 'a' }])
  })

  it('carries `replacedBy` only when one was named', () => {
    const registry = defaultPipelineRegistry()
    registry.retire('old', { replacedBy: 'new' })
    registry.retire('gone')
    expect(registry.retired()).toEqual([{ id: 'old', replacedBy: 'new' }, { id: 'gone' }])
  })

  it('re-retiring an id replaces its tombstone in place instead of duplicating it', () => {
    const registry = defaultPipelineRegistry()
    registry.retire('old')
    registry.retire('other')
    registry.retire('old', { replacedBy: 'new' })
    expect(registry.retired()).toEqual([{ id: 'old', replacedBy: 'new' }, { id: 'other' }])
  })

  it('registering a retired id UN-retires it: an id is never both live and withdrawn', () => {
    // The two calls are opposite assertions about the same id, so the later one has to win in
    // both directions. A registry that only dropped the registration on retire would leave a
    // re-registered pipeline seeded into new workspaces AND offered for removal on old ones.
    const registry = defaultPipelineRegistry()
    registry.retire('a')
    registry.register(pipeline('a'))
    expect(registry.retired()).toEqual([])
    expect(registry.registered().map((p) => p.id)).toEqual(['a'])
  })

  it('merges a registration over the built-in of the same id, in the built-in position', () => {
    const registry = defaultPipelineRegistry()
    registry.register(pipeline('builtin-2', { name: 'overridden' }))
    const merged = registry.merge([pipeline('builtin-1'), pipeline('builtin-2')])
    expect(merged.map((p) => p.id)).toEqual(['builtin-1', 'builtin-2'])
    expect(merged[1]?.name).toBe('overridden')
  })

  it('appends a registration naming no built-in, after the built-ins', () => {
    const registry = defaultPipelineRegistry()
    registry.register(pipeline('extra'))
    expect(registry.merge([pipeline('builtin-1')]).map((p) => p.id)).toEqual(['builtin-1', 'extra'])
  })

  it('never mutates the built-in list it was handed', () => {
    const registry = defaultPipelineRegistry()
    registry.register(pipeline('extra'))
    const builtins = [pipeline('builtin-1')]
    registry.merge(builtins)
    expect(builtins.map((p) => p.id)).toEqual(['builtin-1'])
  })

  it('merges a retirement over an already-retired built-in in place', () => {
    // A deployment points `replacedBy` at its OWN pipeline for a built-in kernel already
    // tombstoned; that is a replacement of the entry, not a second tombstone for one id.
    const registry = defaultPipelineRegistry()
    registry.retire('pl_old', { replacedBy: 'pl_mine' })
    const merged = registry.mergeRetired([{ id: 'pl_old' }, { id: 'pl_other' }])
    expect(merged).toEqual([{ id: 'pl_old', replacedBy: 'pl_mine' }, { id: 'pl_other' }])
  })

  it('appends a retirement the built-in tombstones do not name', () => {
    const registry = defaultPipelineRegistry()
    registry.retire('pl_mine')
    const builtins = [{ id: 'pl_old' }]
    expect(registry.mergeRetired(builtins)).toEqual([{ id: 'pl_old' }, { id: 'pl_mine' }])
    expect(builtins).toEqual([{ id: 'pl_old' }])
  })

  it('starts empty, so a fresh container build inherits nothing from a previous one', () => {
    expect(defaultPipelineRegistry().registered()).toEqual([])
    expect(defaultPipelineRegistry().retired()).toEqual([])
  })
})
