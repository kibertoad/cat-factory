import type { DescriptorField } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import {
  GateRegistry,
  type GateDefinition,
  type GateFactory,
  defaultGateRegistry,
  recordGateAttempt,
  stubGateContext,
} from './gate-registry.js'
import { defaultProviderRegistry, defineProviderToken } from './provider-registry.js'
import type { GateStepState } from './types.js'

const gate = (over: Partial<GateStepState> = {}): GateStepState => ({
  phase: 'checking',
  attempts: 2,
  maxAttempts: 3,
  headSha: 'abc1234',
  ...over,
})

describe('recordGateAttempt', () => {
  it('records a completed helper run with the helper output as the summary', () => {
    const attempt = recordGateAttempt(
      gate(),
      { state: 'done', output: 'Could not fully resolve (2 file(s) still conflicted: a, b).' },
      1_000,
    )
    expect(attempt).toEqual({
      attempt: 2,
      at: 1_000,
      outcome: 'completed',
      headSha: 'abc1234',
      summary: 'Could not fully resolve (2 file(s) still conflicted: a, b).',
    })
  })

  it('records a failed helper run with the error as the summary', () => {
    const attempt = recordGateAttempt(
      gate(),
      { state: 'failed', error: 'Container evicted' },
      2_000,
    )
    expect(attempt.outcome).toBe('failed')
    expect(attempt.summary).toBe('Container evicted')
    expect(attempt.attempt).toBe(2)
  })

  it('falls back to a generic message when a failed job has no error text', () => {
    const attempt = recordGateAttempt(gate(), { state: 'failed', error: null }, 3_000)
    expect(attempt.summary).toBe('The helper agent failed without finishing.')
  })

  it('carries a null summary when a completed job produced no output', () => {
    const attempt = recordGateAttempt(gate(), { state: 'done', output: null }, 4_000)
    expect(attempt.outcome).toBe('completed')
    expect(attempt.summary).toBeNull()
  })

  it('stamps the current attempt number and gated head sha onto the record', () => {
    const attempt = recordGateAttempt(
      gate({ attempts: 1, headSha: null }),
      { state: 'done', output: 'pushed a fix' },
      5_000,
    )
    expect(attempt.attempt).toBe(1)
    expect(attempt.headSha).toBeNull()
  })

  it('captures the fixing instructions handed to the helper this round', () => {
    const attempt = recordGateAttempt(
      gate({ lastDispatchedInstructions: '2 check(s) failing: build, lint.' }),
      { state: 'done', output: 'pushed a fix' },
      6_000,
    )
    expect(attempt.instructions).toBe('2 check(s) failing: build, lint.')
  })

  it('captures the structured failing checks handed to a CI-gate helper round', () => {
    const failingChecks = [{ name: 'build', conclusion: 'failure', url: null }]
    const attempt = recordGateAttempt(
      gate({ lastDispatchedInstructions: '1 check failing: build.', failingChecks }),
      { state: 'done', output: null },
      7_000,
    )
    expect(attempt.failingChecks).toEqual(failingChecks)
    expect(attempt.instructions).toBe('1 check failing: build.')
  })

  it('omits instructions / failingChecks when the gate handed the helper none (conflicts gate)', () => {
    const attempt = recordGateAttempt(gate(), { state: 'done', output: 'resolved' }, 8_000)
    expect(attempt).not.toHaveProperty('instructions')
    expect(attempt).not.toHaveProperty('failingChecks')
  })
})

// The app-owned seam a deployment adds its own polling gate through, and the same one the
// platform's own gates use (`@cat-factory/gates` calls `register` exactly as anyone else would).
// It is deliberately empty on construction, so "the built-ins are missing" and "nobody installed
// them" are the same observable state, which is what makes the dogfood real.
describe('GateRegistry', () => {
  const definition = (kind: string): GateDefinition => ({ kind }) as GateDefinition
  const factoryFor =
    (kind: string): GateFactory =>
    () =>
      definition(kind)

  const field = (key: string): DescriptorField =>
    ({ key, label: key, type: 'text' }) as DescriptorField

  it('is empty on construction, so the built-ins are a deliberate install', () => {
    const registry = defaultGateRegistry()
    expect(registry.factories()).toEqual([])
    expect(registry.has('ci')).toBe(false)
    expect(registry.configForms()).toEqual([])
  })

  it('keys a registered gate by the step kind it gates', () => {
    const registry = new GateRegistry()
    const factory = factoryFor('ci')
    registry.register('ci', factory)
    expect(registry.has('ci')).toBe(true)
    expect(registry.has('conflicts')).toBe(false)
    expect(registry.factories()).toEqual([{ kind: 'ci', factory }])
  })

  it('lists the factories in registration order', () => {
    const registry = new GateRegistry()
    registry.register('ci', factoryFor('ci'))
    registry.register('conflicts', factoryFor('conflicts'))
    registry.register('post-release-health', factoryFor('post-release-health'))
    expect(registry.factories().map((entry) => entry.kind)).toEqual([
      'ci',
      'conflicts',
      'post-release-health',
    ])
  })

  it('hands back the SAME factory it was given, unwrapped', () => {
    // The engine invokes it once with a real `GateContext`, so anything that re-wrapped or
    // pre-invoked it here would close over the wrong seams.
    const registry = new GateRegistry()
    const factory = factoryFor('ci')
    registry.register('ci', factory)
    const [entry] = registry.factories()
    expect(entry?.factory).toBe(factory)
    expect(entry?.factory(stubGateContext())).toEqual(definition('ci'))
  })

  it('lets a later registration REPLACE an earlier one for the same kind', () => {
    // How a deployment overrides a built-in: it registers after `registerBuiltinGates`, and the
    // kind must not end up listed twice with the platform's factory still reachable.
    const registry = new GateRegistry()
    registry.register('ci', factoryFor('builtin'))
    const override = factoryFor('override')
    registry.register('ci', override)
    expect(registry.factories()).toEqual([{ kind: 'ci', factory: override }])
  })

  describe('config fields', () => {
    it('reports the fields a gate declared', () => {
      const registry = new GateRegistry()
      const fields = [field('workflow')]
      registry.register('ci', factoryFor('ci'), { configFields: fields })
      expect(registry.configFields('ci')).toEqual(fields)
    })

    it('reports undefined for a gate that declared none, and for one that is not registered', () => {
      // The two are different facts and both mean "this step may carry no gate config": an
      // undeclared field is indistinguishable from a typo'd one, so neither may be accepted.
      const registry = new GateRegistry()
      registry.register('conflicts', factoryFor('conflicts'))
      expect(registry.configFields('conflicts')).toBeUndefined()
      expect(registry.configFields('nope')).toBeUndefined()
    })

    it('keeps an override that drops the fields from inheriting the previous declaration', () => {
      const registry = new GateRegistry()
      registry.register('ci', factoryFor('builtin'), { configFields: [field('workflow')] })
      registry.register('ci', factoryFor('override'))
      expect(registry.configFields('ci')).toBeUndefined()
    })

    it('projects only the gates that declare an authoring form', () => {
      const registry = new GateRegistry()
      const fields = [field('workflow')]
      registry.register('ci', factoryFor('ci'), { configFields: fields })
      registry.register('conflicts', factoryFor('conflicts'))
      registry.register('post-release-health', factoryFor('health'), { configFields: [] })
      // An empty declaration renders nothing, so it is omitted rather than projected as a form
      // with no fields in it.
      expect(registry.configForms()).toEqual([{ kind: 'ci', fields }])
    })
  })
})

// The `GateContext` every gate test in `@cat-factory/gates` builds from. It lives here so a new
// required context field is filled in ONE place, which only holds if the defaults stay harmless
// and the two seams a caller does supply (the provider registry, the overrides) actually win.
describe('stubGateContext', () => {
  const TOKEN = defineProviderToken<{ name: string }>('test-provider')

  it('defaults to harmless no-ops', async () => {
    const ctx = stubGateContext()
    expect(ctx.clock.now()).toBe(0)
    await expect(ctx.getBlock('ws', 'blk')).resolves.toBeNull()
    await expect(ctx.raiseNotification('ws', {} as never)).resolves.toBeUndefined()
    expect(await ctx.runInitiatorScope({ workspaceId: 'ws' }, async () => 'ran')).toBe('ran')
  })

  it('reads the provider seams off the registry it was given', () => {
    // A gate test wires its provider on that registry and expects `probe()` to find it — and
    // expects `requireProvider` on an unwired token to throw exactly as it would in production.
    const providerRegistry = defaultProviderRegistry()
    const impl = { name: 'wired' }
    providerRegistry.wire(TOKEN, impl)
    const ctx = stubGateContext({}, providerRegistry)
    expect(ctx.isProviderWired(TOKEN)).toBe(true)
    expect(ctx.getProvider(TOKEN)).toBe(impl)
    expect(ctx.requireProvider(TOKEN)).toBe(impl)
  })

  it('reports an unwired token as unwired on the default (empty) registry', () => {
    const ctx = stubGateContext()
    expect(ctx.isProviderWired(TOKEN)).toBe(false)
    expect(ctx.getProvider(TOKEN)).toBeUndefined()
    expect(() => ctx.requireProvider(TOKEN)).toThrow('is not wired')
  })

  it('lets an override replace a default seam', () => {
    const ctx = stubGateContext({ clock: { now: () => 1_234 } })
    expect(ctx.clock.now()).toBe(1_234)
  })
})
