import type { LanguageModel } from 'ai'
import { describe, expect, it } from 'vitest'
import type { ModelProvider, ModelRef } from '@cat-factory/kernel'
import {
  LimitedModelProvider,
  VendorConcurrencyLimiter,
  limitModelProvider,
  vendorConcurrencyLimiterFromEnv,
} from './limited.js'
import { Semaphore } from './semaphore.js'

// A controllable async task: it reports how many run concurrently and blocks until released,
// so a test can drive N of them at once and observe the peak concurrency a limiter allowed.
function makeGate() {
  let active = 0
  let maxActive = 0
  const releases: Array<() => void> = []
  const task = async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise<void>((resolve) => releases.push(resolve))
    active -= 1
    return maxActive
  }
  const releaseAll = () => {
    while (releases.length) releases.shift()!()
  }
  const releaseOne = () => releases.shift()?.()
  return {
    task,
    releaseAll,
    releaseOne,
    get pending() {
      return releases.length
    },
    get maxActive() {
      return maxActive
    },
  }
}

const KIMI_SUBSCRIPTION_REF: ModelRef = {
  provider: 'moonshot',
  model: 'kimi-k2.6',
  harness: 'claude-code',
}
const OPENAI_REF: ModelRef = { provider: 'openai', model: 'gpt-4o-mini' }

/** A fake LanguageModel whose doGenerate blocks until released, to observe gated concurrency. */
function makeBlockingModel(gate: ReturnType<typeof makeGate>): LanguageModel {
  return {
    specificationVersion: 'v3',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    async doGenerate() {
      await gate.task()
      return { content: [], finishReason: 'stop', usage: {}, warnings: [] }
    },
    async doStream() {
      throw new Error('not used')
    },
  } as unknown as LanguageModel
}

async function tick() {
  // Let queued microtasks (blocked acquires) settle before measuring/releasing.
  await new Promise((r) => setTimeout(r, 0))
}

describe('Semaphore', () => {
  it('never runs more than its permit count concurrently and completes all', async () => {
    const sem = new Semaphore(2)
    const gate = makeGate()
    const runs = Array.from({ length: 6 }, () => sem.run(gate.task))
    await tick()
    expect(gate.pending).toBe(2) // only 2 admitted at once
    gate.releaseAll()
    // Drain the queue in waves as permits free up.
    for (let i = 0; i < 4; i++) {
      await tick()
      gate.releaseAll()
    }
    await Promise.all(runs)
    expect(gate.maxActive).toBe(2)
  })

  it('rejects a non-positive permit count', () => {
    expect(() => new Semaphore(0)).toThrow()
    expect(() => new Semaphore(-1)).toThrow()
  })
})

describe('VendorConcurrencyLimiter', () => {
  it('caps a configured vendor and leaves an unconfigured vendor unbounded', async () => {
    const limiter = new VendorConcurrencyLimiter({ kimi: 2 })
    expect(limiter.limitFor('kimi')).toBe(2)
    expect(limiter.limitFor('claude')).toBeUndefined()

    const capped = makeGate()
    const cappedRuns = Array.from({ length: 5 }, () => limiter.run('kimi', capped.task))
    await tick()
    expect(capped.pending).toBe(2)

    const free = makeGate()
    const freeRuns = Array.from({ length: 5 }, () => limiter.run('claude', free.task))
    await tick()
    expect(free.pending).toBe(5) // uncapped: all admitted immediately

    capped.releaseAll()
    free.releaseAll()
    for (let i = 0; i < 5; i++) {
      await tick()
      capped.releaseAll()
    }
    await Promise.all([...cappedRuns, ...freeRuns])
    expect(capped.maxActive).toBe(2)
    expect(free.maxActive).toBe(5)
  })

  it('treats a zero/absent limit as uncapped', async () => {
    const limiter = new VendorConcurrencyLimiter({ kimi: 0 })
    expect(limiter.limitFor('kimi')).toBeUndefined()
    expect(limiter.isEmpty).toBe(true)
  })
})

describe('vendorConcurrencyLimiterFromEnv', () => {
  it('caps every subscription vendor at the default when nothing is set', () => {
    const limiter = vendorConcurrencyLimiterFromEnv(() => undefined)
    for (const vendor of ['claude', 'codex', 'kimi', 'deepseek', 'glm'] as const) {
      expect(limiter.limitFor(vendor)).toBe(3)
    }
  })

  it('honours the global override and a per-vendor override', () => {
    const env: Record<string, string> = {
      LLM_SUBSCRIPTION_MAX_CONCURRENCY: '5',
      LLM_SUBSCRIPTION_MAX_CONCURRENCY_KIMI: '1',
    }
    const limiter = vendorConcurrencyLimiterFromEnv((key) => env[key])
    expect(limiter.limitFor('claude')).toBe(5)
    expect(limiter.limitFor('kimi')).toBe(1)
  })

  it('disables limiting entirely when the default is set to 0', () => {
    const limiter = vendorConcurrencyLimiterFromEnv((key) =>
      key === 'LLM_SUBSCRIPTION_MAX_CONCURRENCY' ? '0' : undefined,
    )
    expect(limiter.isEmpty).toBe(true)
    expect(limiter.limitFor('claude')).toBeUndefined()
  })
})

describe('LimitedModelProvider', () => {
  function providerReturning(model: LanguageModel): ModelProvider {
    return { resolve: () => model }
  }

  it('passes a non-subscription ref through untouched', () => {
    const gate = makeGate()
    const model = makeBlockingModel(gate)
    const provider = new LimitedModelProvider(
      providerReturning(model),
      new VendorConcurrencyLimiter({ kimi: 1 }),
    )
    expect(provider.resolve(OPENAI_REF)).toBe(model)
  })

  it('passes an uncapped subscription vendor through untouched', () => {
    const gate = makeGate()
    const model = makeBlockingModel(gate)
    const provider = new LimitedModelProvider(
      providerReturning(model),
      new VendorConcurrencyLimiter({ claude: 1 }), // kimi not capped
    )
    expect(provider.resolve(KIMI_SUBSCRIPTION_REF)).toBe(model)
  })

  it('gates concurrent generations to a capped subscription vendor', async () => {
    const gate = makeGate()
    const provider = new LimitedModelProvider(
      providerReturning(makeBlockingModel(gate)),
      new VendorConcurrencyLimiter({ kimi: 2 }),
    )
    const wrapped = provider.resolve(KIMI_SUBSCRIPTION_REF)
    expect(wrapped).not.toBe(undefined)

    const call = () =>
      (wrapped as unknown as { doGenerate: (o: unknown) => Promise<unknown> }).doGenerate({
        prompt: [],
      })
    const runs = Array.from({ length: 5 }, call)
    await tick()
    expect(gate.pending).toBe(2) // cap holds through the wrapped model

    gate.releaseAll()
    for (let i = 0; i < 5; i++) {
      await tick()
      gate.releaseAll()
    }
    await Promise.all(runs)
    expect(gate.maxActive).toBe(2)
  })
})

describe('limitModelProvider', () => {
  it('returns the inner provider unchanged when nothing is capped', () => {
    const inner: ModelProvider = { resolve: () => makeBlockingModel(makeGate()) }
    expect(limitModelProvider(inner, new VendorConcurrencyLimiter({}))).toBe(inner)
  })

  it('wraps the inner provider when a vendor is capped', () => {
    const inner: ModelProvider = { resolve: () => makeBlockingModel(makeGate()) }
    const wrapped = limitModelProvider(inner, new VendorConcurrencyLimiter({ kimi: 1 }))
    expect(wrapped).not.toBe(inner)
    expect(wrapped).toBeInstanceOf(LimitedModelProvider)
  })
})
