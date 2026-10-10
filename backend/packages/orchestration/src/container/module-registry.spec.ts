import { describe, expect, it } from 'vitest'
import { ModuleRegistry } from './module-registry.js'

/**
 * The optional-module registry underpins `createCore`'s assembly (it replaces the ~40
 * `const x = createX(...)` + `...(x ? { x } : {})` pairs). These pin its three guarantees:
 * unwired keys are ABSENT (not `undefined`-valued), a built module is readable by later
 * modules via `get`, and `build` returns the value so a consumer can keep a local.
 */
describe('ModuleRegistry', () => {
  it('omits a module whose factory returns undefined (unwired stays absent)', () => {
    const registry = new ModuleRegistry()
    registry.build('slack', () => undefined)
    const assembled = registry.assemble()
    expect('slack' in assembled).toBe(false)
    expect(registry.get('slack')).toBeUndefined()
  })

  it('stores and returns a built module', () => {
    const registry = new ModuleRegistry()
    const preview = { service: {} } as never
    const returned = registry.build('preview', () => preview)
    expect(returned).toBe(preview)
    expect(registry.get('preview')).toBe(preview)
    expect(registry.assemble().preview).toBe(preview)
  })

  it('lets a later module read an earlier one via get (dependency order)', () => {
    const registry = new ModuleRegistry()
    const built: string[] = []
    registry.build('notifications', () => {
      built.push('notifications')
      return { service: {} } as never
    })
    // A dependent module reads the earlier one; if it were undefined this would throw.
    registry.build('requirements', () => {
      const notifications = registry.get('notifications')
      built.push(notifications ? 'requirements+notifications' : 'requirements')
      return { service: {} } as never
    })
    expect(built).toEqual(['notifications', 'requirements+notifications'])
  })

  it('assembles only the wired subset', () => {
    const registry = new ModuleRegistry()
    registry.build('slack', () => undefined)
    registry.build('preview', () => ({ service: {} }) as never)
    registry.build('tracker', () => undefined)
    expect(Object.keys(registry.assemble())).toEqual(['preview'])
  })
})
