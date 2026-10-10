import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppCaches } from '@cat-factory/caching'
import type { AppCachesProfile } from '@cat-factory/caching'
import {
  DurableObjectCacheGenerationStore,
  resetWorkerAppCachesForTests,
  workerAppCaches,
} from '../../src/infrastructure/appCachesHost'
import type { Env } from '../../src/infrastructure/env'
import { runWithExecutionContext } from '../../src/infrastructure/requestContext'

/**
 * The Worker half of the pull-coherency mechanism, on real workerd: the
 * CacheGenerationDirectory Durable Object (per-group shards of per-cache generation
 * counters), the fetch-RPC store adapter, and the module-scope cache bag host. The
 * runtime-neutral tracker semantics (windows, fencing, error posture) are pinned in
 * `@cat-factory/caching`'s own suite; what only this harness can prove is the DO's
 * behaviour and the two bags converging through it.
 */
describe('CacheGenerationDirectory', () => {
  function shard(group: string) {
    const ns = env.CACHE_GENERATIONS!
    return ns.get(ns.idFromName(group))
  }

  it('a fresh shard answers an empty generation map', async () => {
    const res = await shard('cachegen_fresh').fetch('http://cache-generations/generations')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })

  it('bump increments per cache name and the read returns every counter at once', async () => {
    const stub = shard('cachegen_bump')
    const bump = (cacheName: string) =>
      stub.fetch('http://cache-generations/bump', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cacheName }),
      })
    expect(await (await bump('workspace-settings')).json()).toEqual({ generation: 1 })
    expect(await (await bump('workspace-settings')).json()).toEqual({ generation: 2 })
    expect(await (await bump('fragment-catalog')).json()).toEqual({ generation: 1 })
    const generations = await (await stub.fetch('http://cache-generations/generations')).json()
    expect(generations).toEqual({ 'workspace-settings': 2, 'fragment-catalog': 1 })
  })

  it('shards are isolated per group name', async () => {
    await shard('cachegen_iso_a').fetch('http://cache-generations/bump', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cacheName: 'workspace-settings' }),
    })
    const other = await (
      await shard('cachegen_iso_b').fetch('http://cache-generations/generations')
    ).json()
    expect(other).toEqual({})
  })

  it('refuses unknown routes and malformed bumps', async () => {
    const stub = shard('cachegen_bad')
    expect((await stub.fetch('http://cache-generations/nope')).status).toBe(400)
    expect(
      (
        await stub.fetch('http://cache-generations/bump', {
          method: 'POST',
          body: 'not json',
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await stub.fetch('http://cache-generations/bump', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cacheName: 42 }),
        })
      ).status,
    ).toBe(400)
  })
})

describe('cross-instance coherency over the real directory', () => {
  // Window 0 ⇒ probe on every read: the cross-isolate convergence path with no waiting.
  const COHERENT_REPO_PROJECTION: Partial<AppCachesProfile> = {
    repoProjection: {
      enabled: true,
      ttlInMsecs: 5 * 60_000,
      maxGroups: 10,
      maxItemsPerGroup: 1,
      coherencyWindowMsecs: 0,
    },
  }
  const repos = (name: string) => [{ githubId: 1, owner: 'acme', name } as never]

  it("one bag's invalidation reaches a second bag through the Durable Object", async () => {
    const store = new DurableObjectCacheGenerationStore(env.CACHE_GENERATIONS!)
    const writer = createAppCaches({
      profile: COHERENT_REPO_PROJECTION,
      generationStore: store,
    })
    const reader = createAppCaches({
      profile: COHERENT_REPO_PROJECTION,
      generationStore: store,
    })
    const ws = 'cachegen_ws_converge'
    let loads = 0
    const load = (name: string) => async () => {
      loads += 1
      return repos(name)
    }
    const first = await reader.repoProjection.get(ws, ws, load('before'))
    expect((first[0] as { name: string }).name).toBe('before')
    // Cached: a re-read within the same bag serves from memory even at window 0
    // (the probe found no moved counter).
    await reader.repoProjection.get(ws, ws, load('before'))
    expect(loads).toBe(1)

    await writer.repoProjection.invalidateGroup(ws)
    const after = await reader.repoProjection.get(ws, ws, load('after'))
    expect((after[0] as { name: string }).name).toBe('after')
    expect(loads).toBe(2)
  })
})

describe('workerAppCaches host', () => {
  afterEach(() => {
    resetWorkerAppCachesForTests()
  })

  it('is one bag per isolate, not one per call', () => {
    expect(workerAppCaches(env)).toBe(workerAppCaches(env))
  })

  it('selects the coherent profile when CACHE_GENERATIONS is bound: settings reads cache', async () => {
    const bag = workerAppCaches(env)
    const group = 'cachegen_host_coherent'
    let loads = 0
    const load = async () => {
      loads += 1
      return { settings: null }
    }
    await bag.workspaceSettings.get(group, group, load)
    await bag.workspaceSettings.get(group, group, load)
    expect(loads).toBe(1)
  })

  it('keeps the pass-through stance when the binding is absent', async () => {
    const withoutDirectory = { ...env, CACHE_GENERATIONS: undefined } as Env
    const bag = workerAppCaches(withoutDirectory)
    const group = 'cachegen_host_passthrough'
    let loads = 0
    const load = async () => {
      loads += 1
      return { settings: null }
    }
    await bag.workspaceSettings.get(group, group, load)
    await bag.workspaceSettings.get(group, group, load)
    expect(loads).toBe(2)
  })
  // How long the cross-invocation case waits for both reads to park before giving up and letting
  // the assertion speak. Generous on purpose: it is a deadlock ceiling, never the thing a passing
  // run waits on.
  const PARK_CEILING_MS = 5_000
  // The Worker-specific half of the cross-invocation rule (`invocationScopedLoads.ts`): the bag
  // outlives every invocation, so a cache MISS may not join a load another invocation started:
  // workerd destroys the joining invocation with "Cannot perform I/O on behalf of a different
  // request", at the runtime level, where no `catch` can see it. What only this facade can pin
  // is that the host actually supplies `currentInvocation`; the semantics it buys are pinned
  // runtime-neutrally in `@cat-factory/caching`'s own suite.
  it('does not coalesce two loads that belong to different invocations', async () => {
    const bag = workerAppCaches(env)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // Both reads have to clear their coherency probe and park in their OWN load before the gate
    // opens. Releasing earlier lets the first load finish and PUBLISH, which turns the second read
    // into a cache HIT that never loads at all, and reports one load for a reason this test is not
    // about. So the wait is on that condition rather than on a clock: a fixed sleep sized the two
    // probes by guesswork and lost the race on a loaded CI runner, failing as though the
    // cross-invocation rule had regressed.
    let secondParked!: () => void
    const bothParked = new Promise<void>((resolve) => {
      secondParked = resolve
    })
    let loads = 0
    const load = async () => {
      loads += 1
      if (loads === 2) secondParked()
      await gate
      return { settings: null }
    }
    // Outside any entry-point bracket there is no invocation to attribute a load to, and an
    // invocation the runtime cannot name is one this read cannot prove it shares a context with.
    const both = Promise.all([
      bag.workspaceSettings.get('cachegen_split', 'cachegen_split', load),
      bag.workspaceSettings.get('cachegen_split', 'cachegen_split', load),
    ])
    // The ceiling is not a race window: the passing path resolves `bothParked` as soon as the
    // second load is entered. It exists so a REGRESSION (the second read joining the first) fails
    // on the assertion below, naming what broke, rather than hanging here until the suite times
    // out with nothing to say.
    await Promise.race([bothParked, new Promise((resolve) => setTimeout(resolve, PARK_CEILING_MS))])
    release()
    await both
    expect(loads).toBe(2)
  })

  it('still coalesces two loads inside ONE bracketed invocation', async () => {
    const bag = workerAppCaches(env)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let loads = 0
    const load = async () => {
      loads += 1
      await gate
      return { settings: null }
    }
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext
    const both = runWithExecutionContext(ctx, () =>
      Promise.all([
        bag.workspaceSettings.get('cachegen_same', 'cachegen_same', load),
        bag.workspaceSettings.get('cachegen_same', 'cachegen_same', load),
      ]),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    await both
    // Joining is safe here: both promises were created while serving the same invocation.
    expect(loads).toBe(1)
  })
})
