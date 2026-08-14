import { defaultBinaryGeneratorRegistry } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_BINARY_GENERATORS,
  binaryGeneratorRegistryWithBuiltins,
  registerBuiltinBinaryGenerators,
} from './index.js'

describe('binaryGeneratorRegistryWithBuiltins', () => {
  it('answers exactly the shipped set', () => {
    // Derived from the exported catalog rather than pinned to a number: adding an integration is
    // an ordinary change, and a `toHaveLength(1)` here would fail on it while naming nothing.
    expect(binaryGeneratorRegistryWithBuiltins().ids()).toEqual(
      BUILTIN_BINARY_GENERATORS.map((generator) => generator.id),
    )
  })

  it('leaves the bare default empty, so a facade has to say it wants the shipped set', () => {
    expect(defaultBinaryGeneratorRegistry().ids()).toEqual([])
  })

  it('installs onto an existing instance, keeping what a deployment registered', () => {
    const registry = defaultBinaryGeneratorRegistry()
    registry.register({
      id: 'acme-images',
      name: 'Acme Images',
      summary: 'Makes pictures.',
      description: 'A deployment’s own integration.',
      modalities: ['image'],
    })
    registerBuiltinBinaryGenerators(registry)
    expect(registry.ids()).toContain('acme-images')
    for (const generator of BUILTIN_BINARY_GENERATORS) {
      expect(registry.ids()).toContain(generator.id)
    }
  })

  it('lets a deployment override a shipped id rather than duplicating it', () => {
    const registry = binaryGeneratorRegistryWithBuiltins()
    const shipped = BUILTIN_BINARY_GENERATORS[0]!
    registry.register({
      id: shipped.id,
      name: 'Our own account',
      summary: 'The same vendor on our own terms.',
      description: 'Replaces the shipped definition.',
      modalities: ['image'],
    })
    expect(registry.ids().filter((id) => id === shipped.id)).toEqual([shipped.id])
    expect(registry.views().find((view) => view.id === shipped.id)?.name).toBe('Our own account')
  })
})
