import { describe, expect, it } from 'vitest'
import {
  defaultStepResolverRegistry,
  stubResolverContext,
  type StepCompletionResolver,
  type StepResolverFactory,
} from './step-resolver-registry.js'

// A resolver is registered as a FACTORY the engine invokes once at build time, so what these
// pin is the registry's contract with that engine: registration order, replace-on-re-register,
// and that the factory is handed through untouched (a registry that invoked it eagerly would
// build every deployment resolver at registration time, before the context exists).

const factoryFor = (kind: string): StepResolverFactory => {
  const resolver: StepCompletionResolver = { kind, resolve: async () => undefined }
  return () => resolver
}

describe('StepResolverRegistry', () => {
  it('starts empty: the built-in merger resolver is engine-internal, not a registry entry', () => {
    expect(defaultStepResolverRegistry().factories()).toEqual([])
  })

  it('returns registrations in registration order, keyed by agent kind', () => {
    const registry = defaultStepResolverRegistry()
    registry.register('deployer', factoryFor('deployer'))
    registry.register('archiver', factoryFor('archiver'))
    expect(registry.factories().map((f) => f.kind)).toEqual(['deployer', 'archiver'])
  })

  it('hands the factory through unchanged and does not invoke it', () => {
    const registry = defaultStepResolverRegistry()
    let built = 0
    const factory: StepResolverFactory = () => {
      built += 1
      return { kind: 'deployer', resolve: async () => undefined }
    }
    registry.register('deployer', factory)
    expect(built).toBe(0)
    expect(registry.factories()[0]?.factory).toBe(factory)
    registry.factories()[0]?.factory(stubResolverContext())
    expect(built).toBe(1)
  })

  it('a later registration of the same kind replaces the earlier one, keeping its position', () => {
    const registry = defaultStepResolverRegistry()
    registry.register('deployer', factoryFor('deployer'))
    registry.register('archiver', factoryFor('archiver'))
    const override = factoryFor('deployer-v2')
    registry.register('deployer', override)
    expect(registry.factories().map((f) => f.kind)).toEqual(['deployer', 'archiver'])
    expect(registry.factories()[0]?.factory).toBe(override)
  })
})

describe('stubResolverContext', () => {
  it('runs the function under a PASS-THROUGH initiator scope by default', () => {
    // A stub whose scope swallowed the call would make every resolver test pass vacuously.
    const ctx = stubResolverContext()
    expect(ctx.runInitiatorScope({ workspaceId: 'ws_1', initiatedBy: 'user_1' }, () => 'ran')).toBe(
      'ran',
    )
  })

  it('lets a test override the seam it is asserting on', () => {
    const seen: string[] = []
    const ctx = stubResolverContext({
      runInitiatorScope: (scope, fn) => {
        seen.push(scope.initiatedBy ?? 'nobody')
        return fn()
      },
    })
    ctx.runInitiatorScope({ workspaceId: 'ws_1', initiatedBy: 'user_2' }, () => undefined)
    ctx.runInitiatorScope({ workspaceId: 'ws_1' }, () => undefined)
    expect(seen).toEqual(['user_2', 'nobody'])
  })
})
