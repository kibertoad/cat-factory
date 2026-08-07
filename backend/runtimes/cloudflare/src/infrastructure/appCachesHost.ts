import type { AppCaches } from '@cat-factory/kernel'
import {
  createAppCaches,
  ISOLATE_COHERENT_APP_CACHES_PROFILE,
  ISOLATE_SAFE_APP_CACHES_PROFILE,
} from '@cat-factory/caching'
import type { BackgroundWorkScheduler, CacheGenerationStore } from '@cat-factory/caching'
import { logger, operationalMetrics } from '@cat-factory/server'
import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import type { CacheGenerationDirectory } from './durable-objects/CacheGenerationDirectory'
import type { Env } from './env'
import { currentExecutionContext } from './requestContext'

/**
 * The {@link CacheGenerationStore} the coherent profile probes and bumps: a thin fetch-RPC
 * client over the {@link CacheGenerationDirectory} Durable Object, re-deriving the per-group
 * shard stub on every call (stubs are cheap; holding one would pin per-request state into the
 * module-scope bag). A non-2xx answer throws: the tracker owns the error posture (reads fail
 * closed to pass-through, bumps fail open onto the TTL backstop), so this adapter only reports.
 */
export class DurableObjectCacheGenerationStore implements CacheGenerationStore {
  constructor(private readonly namespace: DurableObjectNamespace<CacheGenerationDirectory>) {}

  async getGenerations(group: string): Promise<Record<string, number>> {
    const response = await this.shard(group).fetch('http://cache-generations/generations')
    if (!response.ok) {
      throw new Error(`cache generation read failed (HTTP ${response.status})`)
    }
    return (await response.json()) as Record<string, number>
  }

  async bump(cacheName: string, group: string): Promise<number> {
    const response = await this.shard(group).fetch('http://cache-generations/bump', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cacheName }),
    })
    if (!response.ok) {
      throw new Error(`cache generation bump failed (HTTP ${response.status})`)
    }
    const { generation } = (await response.json()) as { generation: number }
    return generation
  }

  private shard(group: string) {
    return this.namespace.get(this.namespace.idFromName(group))
  }
}

/**
 * Adopts the work the loaders start and do not await (preemptive refreshes, staleness
 * probes) onto the CURRENT invocation's `waitUntil`, read ambiently at spawn time (see
 * `requestContext.ts`) for why it cannot be captured at construction. Outside any wrapped
 * entry point (a Workflows step) the work runs detached, which is safe to leave un-adopted
 * only because layered-loader guarantees the promise settles fulfilled.
 */
const workerBackgroundWorkScheduler: BackgroundWorkScheduler = (work) => {
  const ctx = currentExecutionContext()
  if (ctx) ctx.waitUntil(work)
  else void work
}

let bag: AppCaches | undefined

/**
 * The Worker's app-cache bag, ONE per isolate rather than one per invocation: a warm isolate
 * keeps its entries across requests, which is what makes the enabled caches caches rather
 * than per-wake memos. Safe to hoist because nothing in the bag captures per-request state:
 * the profile and metrics collector are module singletons, load closures ride each read, and
 * the only captured binding is the generation-directory namespace stub off the first
 * invocation's `env`, which is stable per isolate (the same assumption the module-scope
 * default worker already makes; if workerd ever invalidated it, the symptom is a failed
 * probe, which the fail-closed posture converts to pass-through reads).
 *
 * Profile selection is the coherency opt-in: with the `CACHE_GENERATIONS` binding present the
 * coherent profile runs (pass-through entries flip to TTL + generation probe, one cache at a
 * time; see the profile's doc), and without the binding the isolate-safe pass-through profile is
 * byte-for-byte yesterday's behaviour, so a deployment that upgrades the code without the
 * wrangler edit degrades safely rather than caching without coherency (`createAppCaches`
 * refuses that combination outright).
 *
 * `close()` is never called on the Worker, unchanged: the loaders hold no timers and the
 * store adapter holds no closeable resource, so an isolate's discard is the teardown.
 */
export function workerAppCaches(env: Env): AppCaches {
  bag ??= createAppCaches({
    profile: env.CACHE_GENERATIONS
      ? ISOLATE_COHERENT_APP_CACHES_PROFILE
      : ISOLATE_SAFE_APP_CACHES_PROFILE,
    logger,
    operationalMetrics,
    scheduleBackgroundWork: workerBackgroundWorkScheduler,
    ...(env.CACHE_GENERATIONS
      ? { generationStore: new DurableObjectCacheGenerationStore(env.CACHE_GENERATIONS) }
      : {}),
  })
  return bag
}

/**
 * Drop the isolate's bag so the next {@link workerAppCaches} builds cold. For specs that
 * assert cold-cache behaviour or a different binding shape: the vitest workers pool runs a
 * whole file in one worker, so the singleton otherwise persists across tests exactly as it
 * does across requests in production.
 */
export function resetWorkerAppCachesForTests(): void {
  bag = undefined
}
