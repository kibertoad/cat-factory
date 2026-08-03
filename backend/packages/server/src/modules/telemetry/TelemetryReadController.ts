import { Hono } from 'hono'
import { type MachinePayload, TOKEN_AUDIENCE, signerFor } from '../../auth/signing.js'
import type { AppEnv } from '../../http/env.js'
import { logger } from '../../observability/logger.js'
import {
  MAX_TELEMETRY_READ_CHARS,
  TELEMETRY_READ_METHODS,
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
    const secret = container.config.auth.sessionSecret
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    const payload = secret
      ? await signerFor(secret).verify<MachinePayload>(token, { aud: TOKEN_AUDIENCE.machine })
      : null
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
    const overBound = exceedsBound(bound, body.args)
    if (overBound) {
      // Refused, never clamped: a node that asked for 500 rows and silently got 200 would page
      // on a cursor drawn from a page it believes was complete, losing everything between.
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
      log.warn('telemetry read: response over the byte cap', {
        workspaceId: body.workspaceId,
        repo: body.repo,
        method: body.method,
        chars: serialized.length,
      })
      return c.json({ ok: false, error: { code: 'validation', message: 'result too large' } }, 413)
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

/** The reason `args` breaks the declared bound, or null when it is within it. */
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
      typeof query?.bodyChars === 'number'
        ? query.bodyChars
        : (args[1] as { chars?: unknown } | undefined)?.chars
    if (budget != null && (typeof budget !== 'number' || budget > bound.maxBodyChars)) {
      return `body budget exceeds ${bound.maxBodyChars}`
    }
  }
  return null
}
