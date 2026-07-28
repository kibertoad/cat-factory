import { runPreflightsContract } from '@cat-factory/contracts'
import type { PreflightsModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { UnavailableError } from '@cat-factory/kernel'

/** Resolve the preflight module, or null when the host-probe runtime isn't wired (non-local facade). */
function requirePreflight<E extends AppEnv>(c: Context<E>): PreflightsModule | null {
  return c.get('container').preflight ?? null
}

const unavailable = (): never => {
  throw new UnavailableError('Preflight checks are not available on this deployment')
}

/**
 * Run a set of preflight checks (machine-prerequisite probes with guided remediation) and return
 * one verdict per ref — the setup wizard's live re-check button (slice 7) + any ad-hoc "am I ready
 * to provision?" probe. The probes read the host Docker daemon / filesystem / network, so this
 * succeeds only on the local facade; elsewhere it 503s. Mounted under `/workspaces/:workspaceId`.
 */
export function preflightController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, runPreflightsContract, async (c) => {
    const preflight = requirePreflight(c)
    if (!preflight) return unavailable()
    const { prerequisites } = c.req.valid('json')
    return c.json(await preflight.service.run(prerequisites), 200)
  })

  return app
}
