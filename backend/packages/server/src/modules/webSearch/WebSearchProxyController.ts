import { Hono } from 'hono'
import { ContainerSessionService } from '../../containers/ContainerSessionService.js'
import type { AppEnv } from '../../http/env.js'
import { logger } from '../../observability/logger.js'
import { createWebSearchUpstream } from './upstreams.js'

// The SearXNG-compatible web-search proxy that implementation containers point Pi's
// `web_search` tool at (rpiv-web-tools, SearXNG provider). It is the seam that keeps a
// search-provider key out of the container — exactly like the LLM proxy keeps model
// keys out: the container authenticates with its short-lived, model-locked session
// token (no provider key), and the facade performs the search server-side under its
// own key via the `webSearch` gateway.
//
// The container reaches it at `${proxyBaseUrl}/web-search`, so the SearXNG client
// issues `GET ${that}/search?q=...&format=json` with `Authorization: Bearer <token>`.
// Mounted under `/v1`, which the auth gate treats as public (token-authenticated).

/** Pull the bearer token from the Authorization header (Pi's SearXNG client sends it). */
function bearer(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1]!.trim() : null
}

export function webSearchProxyController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // SearXNG's search endpoint shape: `/search?q=...&format=json`. We always answer
  // JSON regardless of the `format` param (the container only ever asks for json).
  app.get('/v1/web-search/search', async (c) => {
    const { config, gateways, spendService, accountSettings } = c.get('container')

    const secret = config.auth.sessionSecret
    if (!secret) {
      logger.error({ scope: 'webSearchProxy' }, 'web-search proxy: session secret not configured')
      return c.json({ error: { message: 'Web search proxy is not configured' } }, 503)
    }

    // Same model-locked container token the LLM proxy verifies: only our own per-run
    // containers can reach the search upstream, and only while their token is valid.
    const sessions = new ContainerSessionService({ secret })
    const session = await sessions.verify(bearer(c.req.header('authorization')))
    if (!session) {
      logger.warn({ scope: 'webSearchProxy' }, 'web-search proxy: invalid or expired session token')
      return c.json({ error: { message: 'Invalid or expired session token' } }, 401)
    }

    // Resolve the search upstream from the run's account settings (web-search keys moved
    // out of env into the per-account store). A legacy gateway upstream still serves as a
    // fallback when the settings store isn't wired. None ⇒ container web search is off.
    const upstream =
      (accountSettings && session.accountId
        ? createWebSearchUpstream(
            (await accountSettings.service.resolve(session.accountId)).webSearch ?? {},
          )
        : undefined) ?? gateways.webSearch
    if (!upstream) {
      return c.json({ error: { message: 'Web search is not configured' } }, 503)
    }

    // Budget gate: a run that has exhausted its workspace's spend budget can't keep
    // spending on searches either (searches cost money on metered providers).
    if (await spendService.isOverBudget(session.workspaceId)) {
      logger.warn(
        { scope: 'webSearchProxy', workspaceId: session.workspaceId },
        'web-search proxy: spend budget exhausted — refusing search',
      )
      return c.json({ error: { message: 'Spend budget exhausted' } }, 402)
    }

    const query = (c.req.query('q') ?? '').trim()
    // SearXNG returns an empty result set (not an error) for a blank query.
    if (!query) return c.json({ query: '', number_of_results: 0, results: [] })

    const log = logger.child({
      scope: 'webSearchProxy',
      workspaceId: session.workspaceId,
      executionId: session.executionId,
      agentKind: session.agentKind,
    })

    try {
      const { results } = await upstream.search(query)
      log.info({ resultCount: results.length }, 'web-search proxy: served search')
      // Shape the response as SearXNG's `format=json` payload so the extension reads
      // `results[].{url,title,content}` unchanged.
      return c.json({ query, number_of_results: results.length, results })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error({ err: message }, 'web-search proxy: upstream search failed')
      // SearXNG-shaped empty result on failure so the agent degrades gracefully
      // (no results) instead of the tool hard-erroring mid-run.
      return c.json({ query, number_of_results: 0, results: [] }, 502)
    }
  })

  return app
}
