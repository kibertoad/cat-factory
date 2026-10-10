import { describe, expect, it, beforeEach } from 'vitest'
// Raw source imports rather than `node:fs`: these tests run inside workerd, which has no
// filesystem. Vite inlines the text at build time, so the assertion still reads the real file.
import appSource from '../src/app.ts?raw'
import { BinaryGeneratorRegistry } from '@cat-factory/kernel'
import { BUILTIN_BINARY_GENERATORS } from '@cat-factory/binary-generators'
import {
  clearBinaryGeneratorRegistry,
  registerBinaryGeneratorRegistry,
  registeredBinaryGeneratorRegistry,
} from '../src/infrastructure/binaryGenerators'
import { resolveWorkerRegistries } from '../src/infrastructure/container-registries'

// The sibling of `binary-store-seam.coverage.test.ts`, guarding the same Worker-shaped defect for
// the deployment's own GENERATIVE integrations.
//
// A Worker builds a container PER ENTRY POINT. The integrations are needed on entry points that
// take no overrides at all: above all the durable driver, since `ExecutionWorkflow` composes a
// binary-output step's dispatch brief (the selected integrations' views and contract documents) on
// its own `buildContainer(this.env)` per wake.
//
// What makes this one harder to see than the store registry is that it HAS a platform default. An
// override-less build never resolved an empty registry, so nothing looked missing: it resolved the
// SHIPPED set, composed a brief carrying the platform's own integration and none of the
// deployment's, and refused a step selecting one of theirs with `binary_output_generator_invalid`
// on a path nobody is watching. Registration is what closes that.

function registryWith(id: string): BinaryGeneratorRegistry {
  const registry = new BinaryGeneratorRegistry()
  registry.register({
    id,
    name: id,
    summary: `The ${id} integration.`,
    description: `A deployment's own ${id} integration, registered in its own code.`,
    modalities: ['image'],
  })
  return registry
}

describe('the binary-generator registration', () => {
  beforeEach(clearBinaryGeneratorRegistry)

  it('answers the SHIPPED set until one is registered, never an empty registry', () => {
    // The opposite default from the store registry beside it, and deliberately: the built-in
    // `pl_media` preset selects a shipped id, so an empty answer would not read as "this
    // deployment registers no integrations" but as a refused run on the one preset that
    // exercises the flow.
    expect(registeredBinaryGeneratorRegistry().ids()).toEqual(
      BUILTIN_BINARY_GENERATORS.map((generator) => generator.id),
    )
  })

  it('round-trips the registered instance, and the last registration wins', () => {
    const first = registryWith('acme-diffusion')
    const second = registryWith('acme-video')
    registerBinaryGeneratorRegistry(first)
    expect(registeredBinaryGeneratorRegistry()).toBe(first)
    registerBinaryGeneratorRegistry(second)
    expect(registeredBinaryGeneratorRegistry()).toBe(second)
  })

  it('reaches a container built with NO overrides: the durable driver’s shape', () => {
    const registry = registryWith('acme-diffusion')
    registerBinaryGeneratorRegistry(registry)

    // `buildContainer(this.env)` is what `ExecutionWorkflow` calls per wake, and where a
    // binary-output step's brief is composed. Before the registration existed this resolved a
    // fresh built-ins-only instance, so a deployment's own integration was absent from every
    // dispatch the durable path drove.
    expect(resolveWorkerRegistries({}).binaryGeneratorRegistry).toBe(registry)
  })

  it('still lets an injected instance win, so the registration is a fallback and never a merge', () => {
    registerBinaryGeneratorRegistry(registryWith('acme-diffusion'))
    const injected = registryWith('acme-video')

    expect(
      resolveWorkerRegistries({ binaryGeneratorRegistry: injected }).binaryGeneratorRegistry,
    ).toBe(injected)
  })
})

// Matched on IDENTIFIERS rather than whole expressions, for the reason the store guard states:
// what must not silently disappear is the LINK, and a pattern spanning an operator also fails when
// `oxfmt` rewraps the line.
describe('the binary-generator seam reaches every Worker entry point', () => {
  it('is registered by `createApp`, so a deployment assembling its own app gets the same reach', () => {
    expect(appSource).toContain('registerBinaryGeneratorRegistry')
  })
})
