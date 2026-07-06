import type { ConfigProblem } from '@cat-factory/contracts'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { CORS_ALLOWED_HEADERS } from '../http/cors.js'

// ---------------------------------------------------------------------------
// The misconfiguration fallback backend.
//
// When a facade fails to boot because a mandatory env var / binding is missing, it serves THIS
// minimal app instead of exiting. Its whole job is to keep the deployment reachable so the SPA
// can render a dedicated error screen (see the frontend `BackendMisconfiguredScreen`) telling the
// developer exactly what's missing and how to fix it — rather than the generic
// "can't reach the backend" panel a dead process produces.
//
//   - `GET /auth/config` — the SPA's boot handshake. Returns a normally-shaped, auth-disabled
//     config WITH the `misconfigured` problem list, so the boot succeeds and the SPA branches to
//     the error screen.
//   - `GET /health` — liveness. Returns 200 with `status: 'misconfigured'` so the orchestrator
//     does NOT crash-loop the container (which would just restart into the same misconfig, hiding
//     the screen). Honest but alive.
//   - everything else — 503 with the structured problem list, for non-browser / direct callers.
//
// It reflects any request Origin (the problem list carries no secret — only var names, meanings,
// and remedies), so the SPA on a separate dev origin can always read it, regardless of whether the
// (failed) config load ever resolved CORS_ALLOWED_ORIGINS / ENVIRONMENT.
// ---------------------------------------------------------------------------

const AUTH_DISABLED_PROVIDERS = { github: false, password: false, google: false }

/**
 * Build the Response for one request against the fallback backend, keyed off the URL pathname.
 * Pure (no CORS, no framework) so the Worker can reuse it INSIDE its already-CORS'd request
 * pipeline; {@link createMisconfiguredApp} wraps it with CORS for the standalone Node serve.
 */
export function buildMisconfiguredResponse(pathname: string, problems: ConfigProblem[]): Response {
  if (pathname === '/auth/config') {
    return Response.json({
      enabled: false,
      providers: AUTH_DISABLED_PROVIDERS,
      misconfigured: { problems },
    })
  }
  if (pathname === '/health') {
    return Response.json({ status: 'misconfigured' })
  }
  return Response.json(
    {
      error: {
        code: 'backend_misconfigured',
        message:
          'The backend is not configured correctly and cannot serve requests. See `problems` for what to fix.',
        problems,
      },
    },
    { status: 503 },
  )
}

/**
 * The standalone fallback Hono app (used by the Node/local facades, which `serve()` it on the
 * normal port when their boot throws a {@link ConfigValidationError}). Reflects any origin so the
 * SPA can read it cross-origin.
 */
export function createMisconfiguredApp(problems: ConfigProblem[]): Hono {
  const app = new Hono()
  app.use(
    '*',
    cors({
      // The fallback exposes nothing secret (only the problem list + an auth-disabled config), and
      // a failed boot may never have resolved the real allow-list — so reflect the caller's origin
      // unconditionally to guarantee the SPA can read the error screen's data.
      origin: (origin) => origin ?? '*',
      allowHeaders: [...CORS_ALLOWED_HEADERS],
    }),
  )
  app.all('*', (c) => buildMisconfiguredResponse(new URL(c.req.url).pathname, problems))
  return app
}
