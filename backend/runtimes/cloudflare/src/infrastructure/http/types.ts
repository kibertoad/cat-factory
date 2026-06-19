import type { AppEnv as ServerAppEnv } from '@cat-factory/server'
import type { Env } from '../env'

/**
 * Hono generics for the Worker: the shared request Variables (`container`, `user`)
 * from @cat-factory/server, plus the Cloudflare `Env` bindings that the Worker's own
 * runtime controllers (events/webhooks/llm-proxy) read off `c.env`.
 */
export type AppEnv = {
  Bindings: Env
  Variables: ServerAppEnv['Variables']
}
