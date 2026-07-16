import { beforeEach, describe, expect, it } from 'vitest'
import { createAppCaches } from '@cat-factory/caching'
import { seedRiskPolicies } from '@cat-factory/kernel'
import type { RiskPolicy, RiskPolicyRepository, Workspace } from '@cat-factory/kernel'
import { RiskPolicyService } from './RiskPolicyService.js'

// Perf item 23: `resolveRiskPolicy` reads a task's merge preset through the `riskPolicy`
// AppCaches slice, and EVERY `RiskPolicyService` write must invalidate the workspace group so
// the edit is visible on the very next gate evaluation. These tests drive the REAL cache
// (`createAppCaches`) the way the engine's `resolveRiskPolicy` does — warm an entry, then
// mutate through the service — so a missing invalidation would serve the stale warmed value.

const WS = 'ws_1'

function fakeRepo(): RiskPolicyRepository {
  const rows = new Map<string, RiskPolicy>()
  return {
    get: async (_ws, id) => rows.get(id) ?? null,
    getDefault: async () => [...rows.values()].find((p) => p.isDefault) ?? null,
    list: async () => [...rows.values()],
    upsert: async (_ws, preset) => {
      // Single-default invariant (matches the real repo): promoting one demotes the rest.
      if (preset.isDefault) for (const p of rows.values()) p.isDefault = false
      rows.set(preset.id, { ...preset })
    },
    remove: async (_ws, id) => {
      rows.delete(id)
    },
  }
}

function makeService(
  repo: RiskPolicyRepository,
  riskPolicyCache?: ReturnType<typeof createAppCaches>['riskPolicy'],
) {
  let seq = 0
  return new RiskPolicyService({
    riskPolicyRepository: repo,
    workspaceRepository: { get: async () => ({ id: WS }) as Workspace } as never,
    idGenerator: { next: (p: string) => `${p}_${++seq}` } as never,
    clock: { now: () => 1000 + seq++ } as never,
    riskPolicyCache,
  })
}

describe('RiskPolicyService risk-policy cache coherence', () => {
  let caches: ReturnType<typeof createAppCaches>
  beforeEach(() => {
    caches = createAppCaches()
  })

  // Mirror the engine read: resolve the default preset through the slice, counting loads.
  function readDefault(repo: RiskPolicyRepository, loads: { n: number }) {
    return caches.riskPolicy.get('default', WS, async () => {
      loads.n++
      return { policy: await repo.getDefault(WS) }
    })
  }

  it('serves a warmed read from cache, then re-loads after a create/update/remove', async () => {
    const repo = fakeRepo()
    const service = makeService(repo, caches.riskPolicy)
    // Seed the workspace catalog (create the first preset → becomes default).
    const created = await service.create(WS, {
      name: 'Cautious',
      maxComplexity: 0.5,
      maxRisk: 0.5,
      maxImpact: 0.5,
      ciMaxAttempts: 3,
      maxRequirementIterations: 6,
      maxRequirementConcernAllowed: 'none',
      maxTesterQualityIterations: 3,
      releaseWatchWindowMinutes: 30,
      releaseMaxAttempts: 1,
      humanReviewGraceMinutes: 0,
      autoMergeEnabled: true,
      isDefault: true,
    } as never)

    const loads = { n: 0 }
    // First read loads; second read is a cache hit (create already invalidated any warm null).
    expect((await readDefault(repo, loads)).policy?.id).toBe(created.id)
    await readDefault(repo, loads)
    expect(loads.n).toBe(1)

    // An update must invalidate — the next read re-loads and sees the new name.
    await service.update(WS, created.id, { name: 'Renamed' })
    expect((await readDefault(repo, loads)).policy?.name).toBe('Renamed')
    expect(loads.n).toBe(2)

    // A remove must invalidate too (default can't be removed, so add a non-default first).
    const extra = await service.create(WS, {
      name: 'Extra',
      maxComplexity: 0.5,
      maxRisk: 0.5,
      maxImpact: 0.5,
      ciMaxAttempts: 3,
      maxRequirementIterations: 6,
      maxRequirementConcernAllowed: 'none',
      maxTesterQualityIterations: 3,
      releaseWatchWindowMinutes: 30,
      releaseMaxAttempts: 1,
      humanReviewGraceMinutes: 0,
      autoMergeEnabled: true,
      isDefault: false,
    } as never)
    await readDefault(repo, loads) // re-warm (create invalidated)
    const warmLoads = loads.n
    await service.remove(WS, extra.id)
    await readDefault(repo, loads)
    expect(loads.n).toBe(warmLoads + 1)
  })

  it('reseed invalidates the workspace group', async () => {
    const repo = fakeRepo()
    const service = makeService(repo, caches.riskPolicy)
    const builtIn = seedRiskPolicies()[0]!
    const loads = { n: 0 }
    await readDefault(repo, loads) // warm (null default on an empty workspace)
    await readDefault(repo, loads)
    expect(loads.n).toBe(1)
    await service.reseed(WS, builtIn.id)
    await readDefault(repo, loads)
    expect(loads.n).toBe(2)
  })

  it('works with no cache wired (pass-through: every write is a no-op invalidation)', async () => {
    const repo = fakeRepo()
    const service = makeService(repo) // no riskPolicyCache
    await expect(
      service.create(WS, {
        name: 'X',
        maxComplexity: 0.5,
        maxRisk: 0.5,
        maxImpact: 0.5,
        ciMaxAttempts: 3,
        maxRequirementIterations: 6,
        maxRequirementConcernAllowed: 'none',
        maxTesterQualityIterations: 3,
        releaseWatchWindowMinutes: 30,
        releaseMaxAttempts: 1,
        humanReviewGraceMinutes: 0,
        autoMergeEnabled: true,
        isDefault: true,
      } as never),
    ).resolves.toBeDefined()
  })
})
