import { describe, expect, it } from 'vitest'
import { defaultJudgeRegistry, stubJudgeContext, type JudgeFactory } from './judge-registry.js'
import { defaultProviderRegistry, defineProviderToken } from './provider-registry.js'

// The registry a deployment registers its own judges on, plus the context stub every judge test
// builds from. What matters here is that the registry hands the FACTORY through untouched (the
// engine invokes it once, with seams that do not exist at registration time) and that the stub's
// provider seams read the registry they were handed rather than a private empty one.

const factoryFor =
  (kind: string): JudgeFactory =>
  () => ({
    kind,
    rubric: { id: `rubric_${kind}`, name: kind, body: 'assess it' },
    onFail: 'park',
  })

describe('JudgeRegistry', () => {
  it('starts empty: the platform ships no built-in judges', () => {
    expect(defaultJudgeRegistry().factories()).toEqual([])
  })

  it('returns registrations in registration order, keyed by the agent kind judged', () => {
    const registry = defaultJudgeRegistry()
    registry.register('scope-adherence', factoryFor('scope-adherence'))
    registry.register('doc-completeness', factoryFor('doc-completeness'))
    expect(registry.factories().map((f) => f.kind)).toEqual(['scope-adherence', 'doc-completeness'])
  })

  it('does not invoke the factory at registration time', () => {
    // The factory closes over engine seams handed to it at BUILD time; invoking it on register
    // would run it before those exist.
    const registry = defaultJudgeRegistry()
    let built = 0
    const factory: JudgeFactory = () => {
      built += 1
      return { kind: 'scope-adherence', rubric: { id: 'r', name: 'r', body: 'b' }, onFail: 'fail' }
    }
    registry.register('scope-adherence', factory)
    expect(built).toBe(0)
    expect(registry.factories()[0]?.factory).toBe(factory)
    expect(registry.factories()[0]?.factory(stubJudgeContext()).onFail).toBe('fail')
    expect(built).toBe(1)
  })

  it('a later registration of the same kind replaces the earlier one, keeping its position', () => {
    const registry = defaultJudgeRegistry()
    registry.register('scope-adherence', factoryFor('scope-adherence'))
    registry.register('doc-completeness', factoryFor('doc-completeness'))
    const override = factoryFor('scope-adherence-v2')
    registry.register('scope-adherence', override)
    expect(registry.factories().map((f) => f.kind)).toEqual(['scope-adherence', 'doc-completeness'])
    expect(registry.factories()[0]?.factory).toBe(override)
  })
})

describe('stubJudgeContext', () => {
  it('reads the provider seams off the registry it was handed', () => {
    // A judge's `wired()` is `ctx.isProviderWired(token)`, so a stub that consulted a private
    // registry would report every judge unwired and turn its tests into pass-throughs.
    const providers = defaultProviderRegistry()
    const TOKEN = defineProviderToken<{ id: string }>('rubric-source')
    const impl = { id: 'wired' }
    providers.wire(TOKEN, impl)
    const ctx = stubJudgeContext({}, providers)
    expect(ctx.isProviderWired(TOKEN)).toBe(true)
    expect(ctx.getProvider(TOKEN)).toBe(impl)
    expect(ctx.requireProvider(TOKEN)).toBe(impl)
  })

  it('reports an unwired token as unwired and throws from `require`', () => {
    const TOKEN = defineProviderToken<{ id: string }>('rubric-source')
    const ctx = stubJudgeContext()
    expect(ctx.isProviderWired(TOKEN)).toBe(false)
    expect(ctx.getProvider(TOKEN)).toBeUndefined()
    expect(() => ctx.requireProvider(TOKEN)).toThrow('Provider "rubric-source" is not wired.')
  })

  it('defaults every other seam to a harmless no-op', async () => {
    const ctx = stubJudgeContext()
    expect(ctx.clock.now()).toBe(0)
    await expect(ctx.getBlock('ws_1', 'blk_1')).resolves.toBeNull()
    await expect(
      ctx.raiseNotification('ws_1', { type: 'judge_review' } as never),
    ).resolves.toBeUndefined()
    expect(ctx.runInitiatorScope({ workspaceId: 'ws_1' }, () => 'ran')).toBe('ran')
  })

  it('lets an override REPLACE a default seam, which is what a judge test asserts on', () => {
    const ctx = stubJudgeContext({ clock: { now: () => 1_700_000_000_000 } })
    expect(ctx.clock.now()).toBe(1_700_000_000_000)
    // The un-overridden seams keep their defaults.
    expect(ctx.getProvider(defineProviderToken('anything'))).toBeUndefined()
  })
})
