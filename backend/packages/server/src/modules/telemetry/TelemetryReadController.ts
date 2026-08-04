import { Hono } from 'hono'
import { verifyMachineRequest } from '../../auth/machineGate.js'
import type { AppEnv } from '../../http/env.js'
import { logger } from '../../observability/logger.js'
import {
  MAX_TELEMETRY_READ_CHARS,
  TELEMETRY_READ_METHODS,
  TELEMETRY_READ_TOO_LARGE_CODE,
  type TelemetryReadBound,
  type TelemetryReadRequest,
} from '../../telemetry/machineTelemetryRead.js'

/**
 * The mothership-mode telemetry READ-THROUGH machine API: `POST /internal/telemetry/read`.
 *
 * The dual of `POST /internal/telemetry/ingest`. The ingest carries a quiesced run's locally
 * captured rows UP; this serves them back DOWN to a node whose own store holds none — because
 * the local retention window has passed, or (the common case in mothership mode, where the SPA
 * shows the whole org's board) because the run was never local at all. Without it those runs
 * render as an empty observability panel, zero rollups and no web-search log, which is
 * indistinguishable from a run that genuinely spent nothing.
 *
 * Security is the same order as every other `/internal/*` surface: the `machine`-audience token
 * pin FIRST (so availability is not probeable), then the capability probe (503), then the
 * workspace to account scope binding — a uniform 404 for anything outside the token's scope, no
 * existence leak.
 *
 * Two properties bound what a compromised node token can do with it:
 *
 * - **The workspace is STAMPED, not passed.** Every method in the table takes `workspaceId`
 *   first; the controller prepends the SCOPE-BOUND id and the request's `args` carry everything
 *   after it. A node cannot address a workspace it can't already reach, even by naming one.
 * - **The method table is closed and bounded.** Only the reads named in
 *   {@link TELEMETRY_READ_METHODS} execute, each held to its declared row cap, and the table is
 *   looked up by OWN PROPERTY only so an attacker-supplied `__proto__` / `constructor` cannot
 *   reach a non-spec member — the same rule the persistence RPC's allow-list follows.
 *
 * It is deliberately NOT allow-listed persistence-RPC methods: that registry resolves a
 * repository WHOLE, so naming a telemetry repo there would route its hot-path writes over the
 * network — the thing the local-first bucket exists to prevent (ADR 0009).
 *
 * Mounted on BOTH facades so either a Node or a Cloudflare deployment can be a mothership. A
 * facade that is not a mothership (no `repositories`) serves a 503.
 * See docs/initiatives/mothership-mode.md.
 */
export function telemetryReadController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post('/internal/telemetry/read', async (c) => {
    const container = c.get('container')

    // Auth first (before the seam probe) — a token-less caller can't tell a mothership from a
    // non-mothership facade.
    const payload = await verifyMachineRequest(c)
    if (!payload) {
      return c.json(
        { ok: false, error: { code: 'forbidden', message: 'invalid machine token' } },
        403,
      )
    }

    const repos = container.repositories
    const workspaceRepository = repos?.workspaceRepository
    if (!repos || typeof workspaceRepository?.accountOf !== 'function') {
      return c.json(
        { ok: false, error: { code: 'internal', message: 'telemetry read not enabled' } },
        503,
      )
    }

    let body: TelemetryReadRequest
    try {
      body = (await c.req.json()) as TelemetryReadRequest
    } catch {
      return c.json(
        { ok: false, error: { code: 'validation', message: 'invalid request body' } },
        422,
      )
    }
    if (
      !body ||
      typeof body.workspaceId !== 'string' ||
      typeof body.repo !== 'string' ||
      typeof body.method !== 'string' ||
      !Array.isArray(body.args)
    ) {
      return c.json(
        { ok: false, error: { code: 'validation', message: 'workspaceId, repo, method, args' } },
        422,
      )
    }

    const log = logger.child({
      scope: 'telemetryRead',
      nodeId: payload.nodeId,
      userId: payload.userId,
    })

    // Account-scope binding, identical to the ingest's: resolve the workspace to its owning
    // account and refuse anything outside the token's scope as 404.
    const accountId = (await (
      workspaceRepository.accountOf(body.workspaceId) as Promise<string | null | undefined>
    ).catch(() => undefined)) as string | null | undefined
    if (!accountId || !payload.scope.accountIds.includes(accountId)) {
      log.warn('telemetry read: workspace out of scope', { workspaceId: body.workspaceId })
      return c.json({ ok: false, error: { code: 'not_found', message: 'Not found' } }, 404)
    }

    const bound = lookupBound(body.repo, body.method)
    if (!bound) {
      return c.json({ ok: false, error: { code: 'validation', message: 'unknown_method' } }, 422)
    }
    // SHAPE before SIZE, and the two carry different statuses because they are different faults:
    // a malformed argument is unprocessable (422), where a well-formed ask for too much is a size
    // refusal (413) the caller can re-issue smaller.
    const malformed = invalidArgs(bound, body.args)
    if (malformed) {
      return c.json({ ok: false, error: { code: 'validation', message: malformed } }, 422)
    }
    const overBound = exceedsBound(bound, body.args)
    if (overBound) {
      // Refused, never clamped: a node that asked for 500 rows and silently got 200 would page
      // on a cursor drawn from a page it believes was complete, losing everything between.
      //
      // `validation`, deliberately NOT the byte backstop's own code below: this is the caller
      // asking for something it may not have, so the fix is to ask correctly, where an over-large
      // RESPONSE is a legal ask the same cursor can satisfy in smaller pages. The drain retries
      // one and reports the other, so collapsing them would have it retry a request that can only
      // ever fail.
      return c.json({ ok: false, error: { code: 'validation', message: overBound } }, 413)
    }

    const repo = (repos as unknown as Record<string, Record<string, unknown>>)[body.repo]
    const fn = repo?.[body.method]
    if (typeof fn !== 'function') {
      // The table names it but this mothership's registry doesn't serve it — a facade wiring gap
      // rather than a caller error, and distinct from `unknown_method` so it reads as one.
      return c.json(
        { ok: false, error: { code: 'internal', message: `${body.repo} is not wired` } },
        503,
      )
    }

    let value: unknown
    try {
      // The scope-bound workspace is PREPENDED — see the controller note. The reflected registry
      // is structurally typed, so the call is cast at the boundary like the persistence RPC's.
      value = await (fn as (...args: unknown[]) => Promise<unknown>).call(
        repo,
        body.workspaceId,
        ...body.args,
      )
    } catch (error) {
      log.error('telemetry read: query failed', {
        workspaceId: body.workspaceId,
        repo: body.repo,
        method: body.method,
        err: error instanceof Error ? error.message : String(error),
      })
      return c.json({ ok: false, error: { code: 'internal', message: 'Internal error' } }, 500)
    }

    // Byte backstop. The row caps above bound COUNT; this bounds the axis one pathological
    // snapshot moves. Over it the page is REFUSED rather than shortened, for the same reason the
    // bound check refuses: a truncated page is one the node would treat as complete.
    const serialized = JSON.stringify({ ok: true, value })
    if (serialized.length > MAX_TELEMETRY_READ_CHARS) {
      // A ROUTINE condition on a run with large prompts, not a bug: the row caps bound count, and
      // a page within its count can still carry megabytes. `debug`, therefore, not `warn` — the
      // drain halves its page and re-asks on the same cursor, losing nothing, and a warn per page
      // would make the ordinary rendering of a heavy run look like an incident.
      log.debug(
        'telemetry read: response over the byte cap, refusing so the caller can page smaller',
        {
          workspaceId: body.workspaceId,
          repo: body.repo,
          method: body.method,
          chars: serialized.length,
          maxChars: MAX_TELEMETRY_READ_CHARS,
        },
      )
      return c.json(
        {
          ok: false,
          error: {
            code: TELEMETRY_READ_TOO_LARGE_CODE,
            message: `result of ${serialized.length} chars exceeds ${MAX_TELEMETRY_READ_CHARS}; retry with a smaller limit`,
          },
        },
        413,
      )
    }
    return c.body(serialized, 200, { 'content-type': 'application/json' })
  })

  return app
}

/**
 * The declared bound for `repo.method`, or null when the pair is not in the table. Both lookups
 * are OWN-PROPERTY only, so `__proto__` / `constructor` / `toString` name nothing.
 */
function lookupBound(repo: string, method: string): TelemetryReadBound | null {
  if (!Object.hasOwn(TELEMETRY_READ_METHODS, repo)) return null
  const methods = TELEMETRY_READ_METHODS[repo as keyof typeof TELEMETRY_READ_METHODS] as Record<
    string,
    TelemetryReadBound
  >
  if (!Object.hasOwn(methods, method)) return null
  return methods[method] ?? null
}

/**
 * The reason `args` is not the shape its method declares, or null when it is.
 *
 * Checked HERE rather than left to the repository, which would fault on it and report a 500 —
 * `execution_id = undefined` reads as a store outage when it is the caller that is wrong. Arity is
 * part of the shape: the args are SPREAD into the call, so a caller may not slip a positional past
 * the ones its method declares.
 */
function invalidArgs(bound: TelemetryReadBound, args: unknown[]): string | null {
  if (args.length > bound.maxArgs) return `expected at most ${bound.maxArgs} arguments`
  if (bound.args === 'id') {
    const id = args[0]
    return typeof id === 'string' && id.length > 0 ? null : 'expected a non-empty id string'
  }
  const query = args[0]
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    return 'expected a query object'
  }
  const executionId = (query as { executionId?: unknown }).executionId
  // Every read on this table is RUN-SCOPED — that is what makes each one's size knowable. A query
  // with no run names the whole workspace's telemetry, which is the bulk read the bucket forbids.
  return typeof executionId === 'string' && executionId.length > 0
    ? null
    : 'query.executionId must be a non-empty string'
}

/** The reason `args` asks for more than the declared bound allows, or null when it is within it. */
function exceedsBound(bound: TelemetryReadBound, args: unknown[]): string | null {
  const query = args[0] as { limit?: unknown; bodyChars?: unknown } | undefined
  if (bound.limit === 'query.limit' && bound.maxLimit != null) {
    const limit = query?.limit
    // A missing or non-numeric limit is refused rather than defaulted: the caps exist so a
    // response's size is computable before the request, and an unstated limit computes nothing.
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
      return 'limit must be a positive integer'
    }
    if (limit > bound.maxLimit) return `limit exceeds ${bound.maxLimit}`
  }
  if (bound.maxBodyChars != null) {
    // The slice budget rides `query.bodyChars` on a page and `body.chars` on a point read; both
    // are the SECOND positional after the stamped workspace, so read whichever is present.
    const budget =
      bound.args === 'runQuery'
        ? query?.bodyChars
        : (args[1] as { chars?: unknown } | undefined)?.chars
    // REQUIRED, not merely capped. An omitted budget means "the whole bodies" to the port, which
    // is the unstated size this surface exists to refuse — the same reason an omitted `limit` is
    // refused. A caller wanting everything asks for the ceiling and reads `totalChars` to see
    // whether it got everything.
    if (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 0) {
      return `body budget must be an integer between 0 and ${bound.maxBodyChars}`
    }
    if (budget > bound.maxBodyChars) return `body budget exceeds ${bound.maxBodyChars}`
  }
  return null
}
