import { getPublicSpendContract } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { authorize, refuse } from './publicApiAuth.js'

// SPEND ANALYTICS (`GET /api/v1/usage/spend`): the workspace's money over a window, sliced by
// the dimension a budget is actually kept against: a repository, a tracker ticket, a run.
//
// `GET /api/v1/usage` on `PublicApiController` answers the BUDGET question (what has this
// period cost, are runs paused) and structurally cannot answer this one: it groups by
// `(billing, vendor, provider, model)` inside the current calendar month, and the ledger row it
// aggregates carries no board shape at all. Inside the product the answer already existed (the
// Reports panel, account-wide and admin-gated, reading the durable `spend_days` rollup for the
// long windows), so the gap was purely that nothing outside a browser session could reach
// it, and an external cost dashboard had to re-derive attribution it cannot see.
//
// Its own controller, per the precedent `PublicDiscoveryController` states: `PublicApiController`
// is at the size where the ratchet says split rather than grow, and this seam is cohesive (one
// read, one service, none of the engine the board and job routes are built around).
//
// Four things decide the shape:
//
//  1. **`read` scope, and workspace-scoped in SQL.** The key's own account AND its own
//     workspace are both applied to the aggregate, so this can only ever describe the board the
//     caller already addresses. The account-wide view the panel serves is deliberately NOT
//     reachable: a workspace-scoped key must never learn a sibling board's spend, and that is
//     the same rule that keeps the account and user budget tiers off `GET /api/v1/usage`.
//  2. **One dimension per request.** The panel renders every slice at once and pays for eleven
//     aggregates; a caller asks a question. Serving all of them would make the common request
//     seven times the work and the response mostly rows nobody asked for.
//  3. **The response says which STORE answered.** A `24h`/`7d` window scans the live ledger and
//     a `30d`/`90d` one reads the frozen rollup, and the two attribute a repository or a ticket
//     differently on purpose (see the contract). A reader comparing windows has to be told.
//  4. **The rows are BOUNDED and the totals are not.** `run` and `ticket` grow with activity,
//     so an uncapped `90d` breakdown is a response nobody sized; the rows come back heaviest
//     first, `truncated` says when there was a tail, and `totals` still aggregates the whole
//     window, so a capped answer never under-reports what the board spent.

/**
 * The window served when a request names none: the widest one answered LIVE off the ledger, so
 * a caller that states nothing gets millisecond-exact numbers rather than a rollup that may be
 * a sweep behind.
 */
const DEFAULT_SPEND_WINDOW = '7d' as const

/**
 * Slices returned when a request names no `limit`. Comfortably above every catalog-keyed
 * dimension's whole cardinality (a board's models, agent kinds, services, repositories and task
 * types all fit), so the default truncates only the two axes that grow with activity, which are
 * also the two a caller reads the heavy end of. The hard ceiling is the contract's.
 */
const DEFAULT_SPEND_ROWS = 100

export function publicSpendController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, getPublicSpendContract, async (c) => {
    const gate = await authorize(c, getPublicSpendContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const reports = c.get('container').reports
    // Absent only where the deployment wired no reports repository. Stated as unavailable
    // rather than answered with an empty breakdown, which reads as a board that spent nothing.
    if (!reports) {
      return c.json(
        { error: { code: 'unavailable', message: 'Spend analytics is not configured' } },
        503,
      )
    }
    const { dimension, window, limit } = c.req.valid('query')
    const breakdown = await reports.breakdown(
      gate.auth.accountId,
      dimension,
      window ?? DEFAULT_SPEND_WINDOW,
      gate.auth.workspaceId,
      limit ?? DEFAULT_SPEND_ROWS,
    )
    return c.json(
      {
        dimension,
        window: breakdown.window,
        generatedAt: breakdown.generatedAt,
        since: breakdown.since,
        currency: breakdown.currency,
        source: breakdown.source,
        rolledUpThrough: breakdown.rolledUpThrough,
        truncated: breakdown.truncated,
        totals: {
          inputTokens: breakdown.totals.inputTokens,
          outputTokens: breakdown.totals.outputTokens,
          calls: breakdown.totals.calls,
          meteredCost: breakdown.totals.meteredCost,
          subscriptionCost: breakdown.totals.subscriptionCost,
        },
        rows: breakdown.rows.map((row) => ({
          key: row.key,
          label: row.label,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          calls: row.calls,
          meteredCost: row.meteredCost,
          subscriptionCost: row.subscriptionCost,
        })),
      },
      200,
    )
  })

  return app
}
