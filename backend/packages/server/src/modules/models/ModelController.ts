import { Hono } from 'hono'
import type { AppEnv } from '../../http/env'

/**
 * Serves the model picker catalog read-only. Unlike the prompt-fragment catalog
 * this one is deployment-dependent: each model is resolved to the flavour
 * actually in use (direct when its provider key is configured, else the
 * Cloudflare fallback), so the frontend can show which flavour will run. It
 * exposes only labels and provider/model ids — never the keys themselves.
 */
export function modelController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/models', (c) => {
    // Short cache: the catalog only changes when a deployment's keys change.
    c.header('Cache-Control', 'public, max-age=60')
    return c.json(c.get('container').config.models)
  })

  return app
}
