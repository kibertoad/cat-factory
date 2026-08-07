import { describe, expect, it } from 'vitest'
import { resolveWorkerRegistries } from '../src/infrastructure/container-registries'

// ---------------------------------------------------------------------------
// The registries a container built with NO overrides must still carry.
//
// `createWorker` resolves the app-owned registries at the entry point and threads them in as
// overrides, so a deployment's instance always wins. But that is not the only way a container is
// built on this runtime: a cron sweep, a Workflow step and a Durable Object each call
// `buildContainer(env)` directly, with no overrides at all. A registry whose built-ins are
// defaulted only at the entry point is therefore EMPTY on exactly the paths nobody is watching,
// and empty is not an error anywhere — the run just folds no standards and completes.
//
// That is how the prompt-fragment registry shipped: defaulted in `resolveEntryRegistries`, absent
// here, so the engine advanced every re-driven run against an empty pool. So the assertion is on
// `resolveWorkerRegistries({})` (what the override-less builder resolves) rather than on the
// entry point, which cannot see the gap.
// ---------------------------------------------------------------------------

describe('resolveWorkerRegistries with no overrides', () => {
  it('carries the shipped prompt-fragment catalog, not an empty pool', () => {
    const { promptFragmentRegistry } = resolveWorkerRegistries({})

    // A relation over a catalog this test does not own: any shipped fragment proves the built-ins
    // were installed, where a count would fail on every ordinary addition to the catalog.
    expect(promptFragmentRegistry.all().length).toBeGreaterThan(0)
    expect(promptFragmentRegistry.get('node.performance')).toBeDefined()
    expect(promptFragmentRegistry.taskTypesWithDefaults().length).toBeGreaterThan(0)
  })

  it('carries the built-in gate suite, the sibling this default is modelled on', () => {
    // Named beside it so the two read as one rule rather than a fix and a precedent.
    expect(resolveWorkerRegistries({}).gateRegistry.factories().length).toBeGreaterThan(0)
  })

  it('lets an injected registry win, so the default is a fallback and never a merge', () => {
    const { promptFragmentRegistry } = resolveWorkerRegistries({})
    const injected = resolveWorkerRegistries({ promptFragmentRegistry })

    expect(injected.promptFragmentRegistry).toBe(promptFragmentRegistry)
  })
})
