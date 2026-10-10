import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env'

/**
 * The cross-isolate cache-coherency directory: one MONOTONIC generation counter per
 * (cache name, group), read by the pull-coherency probe in `@cat-factory/caching` and
 * bumped by every coherent cache's invalidation path (see `appCachesHost.ts` for the
 * Worker-side store adapter and the profile that opts caches in).
 *
 * Addressed by `idFromName(group)`, one shard per group (a workspace / account / user
 * id, or the reserved `'*'` epoch group carrying cache-WIDE invalidations), so ONE
 * `GET /generations` returns every cache's counter for that group and all coherent
 * caches share a single probe per group per window. Group strings deliberately collide
 * across caches (a workspaceId groups several of them); counters are keyed by cache
 * name inside the shard, so the collision is what makes the batched read work.
 *
 * A shard holds a handful of small integers and nothing else: no alarms, no sockets,
 * no timers. Read-modify-write on `/bump` is safe without a transaction because the
 * DO's input gate holds other events out while a storage operation is in flight.
 */
export class CacheGenerationDirectory extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/generations') {
      const entries = await this.ctx.storage.list<number>()
      return json(Object.fromEntries(entries))
    }

    if (request.method === 'POST' && url.pathname === '/bump') {
      let cacheName: unknown
      try {
        cacheName = ((await request.json()) as { cacheName?: unknown }).cacheName
      } catch {
        return new Response('expected a JSON body', { status: 400 })
      }
      if (typeof cacheName !== 'string' || cacheName.length === 0) {
        return new Response('expected a non-empty string `cacheName`', { status: 400 })
      }
      const generation = ((await this.ctx.storage.get<number>(cacheName)) ?? 0) + 1
      await this.ctx.storage.put(cacheName, generation)
      return json({ generation })
    }

    return new Response('expected GET /generations or POST /bump', { status: 400 })
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })
}
