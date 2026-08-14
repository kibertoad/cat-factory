import { describe, expect, it } from 'vitest'
import {
  PLATFORM_FOUNDATIONAL_SERVICES,
  defaultBinaryGeneratorRegistry,
  defaultFoundationalServiceRegistry,
} from '@cat-factory/kernel'
import {
  BUILTIN_BINARY_GENERATORS,
  binaryGeneratorRegistryWithBuiltins,
} from '@cat-factory/binary-generators'
import { deploymentRegisteredIds } from './mothershipRegistrations.js'

// The mothership boot warns about what a node registered in code, because a node resolves these
// sets from the mothership and its own copy is inert. The whole difficulty is deciding what "a
// node registered" means when the FACADE seeds the same registries with the platform's own
// definitions.

describe('deploymentRegisteredIds', () => {
  it('says nothing about a registry carrying only what the facade seeded', () => {
    // The default boot on both registries. Reported, these would tell an operator to go undo a
    // registration they never made, on every mothership-mode boot they ever run.
    expect(
      deploymentRegisteredIds(
        defaultFoundationalServiceRegistry().all(),
        PLATFORM_FOUNDATIONAL_SERVICES,
      ),
    ).toEqual([])
    expect(
      deploymentRegisteredIds(
        binaryGeneratorRegistryWithBuiltins().all(),
        BUILTIN_BINARY_GENERATORS,
      ),
    ).toEqual([])
  })

  it('names a deployment’s own registration alongside the shipped ones', () => {
    const registry = binaryGeneratorRegistryWithBuiltins()
    registry.register({
      id: 'acme-diffusion',
      name: 'Acme Diffusion',
      summary: 'Acme’s own image API.',
      description: 'The image API this deployment already runs.',
      modalities: ['image'],
    })

    expect(deploymentRegisteredIds(registry.all(), BUILTIN_BINARY_GENERATORS)).toEqual([
      'acme-diffusion',
    ])
  })

  it('names a deployment’s REPLACEMENT of a shipped id, which an id test would call a built-in', () => {
    // The case the warning exists for and the one a subtraction by id cannot see. A registration
    // under a shipped id replaces it, and that replacement is exactly as inert on a node as a
    // brand-new one: the mothership serves whatever IT has under that id.
    const shipped = BUILTIN_BINARY_GENERATORS[0]!
    const registry = binaryGeneratorRegistryWithBuiltins()
    registry.register({
      id: shipped.id,
      name: 'Acme’s own build of it',
      summary: 'Same id, this deployment’s own definition.',
      description: 'Pointed at an internal gateway rather than the vendor.',
      modalities: ['image'],
    })

    expect(deploymentRegisteredIds(registry.all(), BUILTIN_BINARY_GENERATORS)).toEqual([shipped.id])
  })

  it('reports everything on a registry a deployment built from scratch', () => {
    const registry = defaultBinaryGeneratorRegistry()
    registry.register({
      id: 'acme-video',
      name: 'Acme Video',
      summary: 'Acme’s own video API.',
      description: 'The video API this deployment already runs.',
      modalities: ['video'],
    })

    expect(deploymentRegisteredIds(registry.all(), BUILTIN_BINARY_GENERATORS)).toEqual([
      'acme-video',
    ])
  })
})
