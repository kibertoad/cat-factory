import type {
  SubscriptionQuotaCycleRecord,
  SubscriptionQuotaCycleRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  RegistrySubscriptionQuotaProvider,
  type SubscriptionQuotaAdapter,
} from './RegistrySubscriptionQuotaProvider.js'

const FIVE_H = 5 * 60 * 60 * 1000
const WEEK = 7 * 24 * 60 * 60 * 1000

/** An in-memory cycle repo mirroring the windowed UPSERT the D1/Drizzle repos implement. */
function memoryRepo(): SubscriptionQuotaCycleRepository {
  const rows = new Map<string, SubscriptionQuotaCycleRecord>()
  const key = (scope: string, scopeId: string, vendor: string, windowKind: string) =>
    `${scope}|${scopeId}|${vendor}|${windowKind}`
  return {
    async recordUsage(k, usage, at, windowMs) {
      const id = key(k.scope, k.scopeId, k.vendor, k.windowKind)
      const existing = rows.get(id)
      const active = existing && at - existing.windowStartedAt < windowMs
      if (existing && active) {
        existing.inputTokens += usage.inputTokens
        existing.outputTokens += usage.outputTokens
        existing.requestCount += 1
        existing.updatedAt = at
      } else {
        rows.set(id, {
          id: existing?.id ?? k.id,
          scope: k.scope,
          scopeId: k.scopeId,
          vendor: k.vendor,
          windowKind: k.windowKind,
          windowStartedAt: at,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          requestCount: 1,
          updatedAt: at,
        })
      }
    },
    async listByScopeVendor(scope, scopeId, vendor) {
      return [...rows.values()].filter(
        (r) => r.scope === scope && r.scopeId === scopeId && r.vendor === vendor,
      )
    },
    async deleteOlderThan(epochMs) {
      let n = 0
      for (const [id, r] of rows) {
        if (r.windowStartedAt < epochMs) {
          rows.delete(id)
          n += 1
        }
      }
      return n
    },
  }
}

describe('RegistrySubscriptionQuotaProvider', () => {
  it('models both windows from accumulated usage against config ceilings', async () => {
    let now = 1_000
    const repo = memoryRepo()
    let seq = 0
    const provider = new RegistrySubscriptionQuotaProvider({
      subscriptionQuotaCycleRepository: repo,
      idGenerator: { next: (p) => `${p}-${(seq += 1)}` },
      clock: { now: () => now },
    })

    await provider.recordUsage(
      { scope: 'pooled', scopeId: 't1', vendor: 'kimi' },
      {
        inputTokens: 1000,
        outputTokens: 500,
      },
    )
    now += 60_000
    await provider.recordUsage(
      { scope: 'pooled', scopeId: 't1', vendor: 'kimi' },
      {
        inputTokens: 500,
        outputTokens: 200,
      },
    )

    const cycle = await provider.report({ scope: 'pooled', scopeId: 't1', vendor: 'kimi' })
    expect(cycle.source).toBe('modeled')
    const fiveH = cycle.windows.find((w) => w.kind === '5h')!
    // Two runs accumulated into the still-active window.
    expect(fiveH.usedTokens).toBe(2200)
    expect(fiveH.windowStartedAt).toBe(1_000)
    expect(fiveH.resetsAt).toBe(1_000 + FIVE_H)
    expect(fiveH.limitTokens).toBe(8_000_000) // kimi 5h ceiling
    expect(fiveH.usedPercent).toBeCloseTo(2200 / 8_000_000)
    // The weekly window accumulated the same tokens but resets a week out.
    const weekly = cycle.windows.find((w) => w.kind === 'weekly')!
    expect(weekly.usedTokens).toBe(2200)
    expect(weekly.resetsAt).toBe(1_000 + WEEK)
  })

  it('reports an empty window once its anchor ages out (reset)', async () => {
    let now = 0
    const provider = new RegistrySubscriptionQuotaProvider({
      subscriptionQuotaCycleRepository: memoryRepo(),
      idGenerator: { next: (p) => p ?? 'subq' },
      clock: { now: () => now },
    })
    await provider.recordUsage(
      { scope: 'user', scopeId: 'u1', vendor: 'claude' },
      {
        inputTokens: 100,
        outputTokens: 100,
      },
    )
    // Jump past the 5h window but within the weekly one.
    now = FIVE_H + 1
    const cycle = await provider.report({ scope: 'user', scopeId: 'u1', vendor: 'claude' })
    const fiveH = cycle.windows.find((w) => w.kind === '5h')!
    expect(fiveH.usedTokens).toBe(0)
    expect(fiveH.windowStartedAt).toBeNull()
    expect(fiveH.resetsAt).toBeNull()
    const weekly = cycle.windows.find((w) => w.kind === 'weekly')!
    expect(weekly.usedTokens).toBe(200)
  })

  it('prefers a registered vendor adapter, degrading to modeled on a null/throwing read', async () => {
    let now = 10
    const realAdapter: SubscriptionQuotaAdapter = {
      async readWindows() {
        return [
          {
            kind: '5h',
            usedTokens: 42,
            limitTokens: 100,
            usedPercent: 0.42,
            windowStartedAt: 5,
            resetsAt: 999,
            source: 'real',
          },
        ]
      },
    }
    const provider = new RegistrySubscriptionQuotaProvider({
      subscriptionQuotaCycleRepository: memoryRepo(),
      idGenerator: { next: (p) => p ?? 'subq' },
      clock: { now: () => now },
      registry: { glm: realAdapter },
    })
    const real = await provider.report({ scope: 'user', scopeId: 'u1', vendor: 'glm' })
    expect(real.source).toBe('real')
    expect(real.windows[0]!.usedPercent).toBe(0.42)

    // A vendor with no adapter falls back to modeled.
    now = 20
    const modeled = await provider.report({ scope: 'user', scopeId: 'u1', vendor: 'claude' })
    expect(modeled.source).toBe('modeled')

    // A throwing adapter also degrades to modeled rather than propagating.
    const throwing = new RegistrySubscriptionQuotaProvider({
      subscriptionQuotaCycleRepository: memoryRepo(),
      idGenerator: { next: (p) => p ?? 'subq' },
      clock: { now: () => now },
      registry: {
        glm: {
          async readWindows() {
            throw new Error('endpoint down')
          },
        },
      },
    })
    const fell = await throwing.report({ scope: 'user', scopeId: 'u1', vendor: 'glm' })
    expect(fell.source).toBe('modeled')
  })
})
