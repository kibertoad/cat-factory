import { describe, expect, it, beforeEach } from 'vitest'
// Raw source imports rather than `node:fs`: these tests run inside workerd, which has no
// filesystem. Vite inlines the text at build time, so the assertion still reads the real file.
import appSource from '../src/app.ts?raw'
import indexSource from '../src/index.ts?raw'
import { BinaryStoreRegistry } from '@cat-factory/kernel'
import {
  clearBinaryStoreRegistry,
  registerBinaryStoreRegistry,
  registeredBinaryStoreRegistry,
} from '../src/infrastructure/binaryStores'
import { resolveWorkerRegistries } from '../src/infrastructure/container-registries'

// The sibling of `tool-secret-seam.coverage.test.ts`, guarding the same Worker-shaped defect for
// the deployment's own binary artifact stores.
//
// A Worker builds a container PER ENTRY POINT. The stores are needed on entry points that take no
// overrides at all: the durable driver (`ExecutionWorkflow` wakes and the visual-confirmation gate
// stores its screenshots), the queue consumers, and the retention cron, which builds its store
// resolver outside the container entirely. Held only on the app, the registry reached the fetch
// path and nothing else, and the failure is silent in both directions, because "no store" is a
// pass-through for the gate and a skipped workspace for the sweep.
//
// What makes this registry different from every other one `resolveWorkerRegistries` resolves is
// that it has NO platform default to fall back to: its entire content is a deployment's own, so
// "defaulted to an empty instance" and "the deployment registered nothing" are the same value.

function registryWith(id: string): BinaryStoreRegistry {
  const registry = new BinaryStoreRegistry()
  registry.register({
    id,
    name: id,
    create: () => ({
      kind: id,
      put: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
    }),
  })
  return registry
}

describe('the binary-store registration', () => {
  beforeEach(clearBinaryStoreRegistry)

  it('answers an EMPTY registry until one is registered, never undefined', () => {
    // Every reader wants a catalog to look an account's `storeId` up in, and an empty one IS the
    // answer "this build registers no stores", which is what the resolver reports by name.
    expect(registeredBinaryStoreRegistry().ids()).toEqual([])
  })

  it('round-trips the registered instance, and the last registration wins', () => {
    const first = registryWith('gcs')
    const second = registryWith('azure-blob')
    registerBinaryStoreRegistry(first)
    expect(registeredBinaryStoreRegistry()).toBe(first)
    registerBinaryStoreRegistry(second)
    expect(registeredBinaryStoreRegistry()).toBe(second)
  })

  it('reaches a container built with NO overrides: the durable driver’s shape', () => {
    const registry = registryWith('gcs')
    registerBinaryStoreRegistry(registry)

    // `buildContainer(this.env)` is what `ExecutionWorkflow` calls per wake; this is the registry
    // resolution behind it. Before the registration existed this was a fresh empty instance, so a
    // custom-store account's screenshots had nowhere to go and the gate completed without them.
    expect(resolveWorkerRegistries({}).binaryStoreRegistry).toBe(registry)
  })

  it('still lets an injected instance win, so the registration is a fallback and never a merge', () => {
    registerBinaryStoreRegistry(registryWith('gcs'))
    const injected = registryWith('azure-blob')

    expect(resolveWorkerRegistries({ binaryStoreRegistry: injected }).binaryStoreRegistry).toBe(
      injected,
    )
  })
})

// Matched on IDENTIFIERS rather than whole expressions, for the reason the tool-secret guard
// states: what must not silently disappear is the LINK, and a pattern spanning an operator also
// fails when `oxfmt` rewraps the line.
describe('the binary-store seam reaches every Worker entry point', () => {
  it('is registered by `createApp`, so a deployment assembling its own app gets the same reach', () => {
    expect(appSource).toContain('registerBinaryStoreRegistry')
  })

  it('is read by the retention cron, which builds its resolver outside the container', () => {
    expect(indexSource).toContain('registeredBinaryStoreRegistry()')
  })

  it('leaves the cron unable to be handed a DIFFERENT registry than the container sees', () => {
    // `handleScheduled` took the registry as a parameter, threaded from `createWorker`. That fixed
    // the cron and only the cron: the durable driver has no such parameter to be handed, and every
    // future override-less builder would have needed its own. A parameter here is therefore the
    // shape of the bug, not a second belt.
    expect(indexSource).not.toContain('handleScheduled(controller, env, ctx, ')
  })
})
