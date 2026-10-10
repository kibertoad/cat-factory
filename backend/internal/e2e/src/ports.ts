// The ONE derivation of every port and origin the e2e stack uses, read by all four ends: the
// Playwright config (which STARTS the servers and waits on them), `testServer.ts` (the backend, the
// control channel and the auth-enabled surface), `authFrontend.mjs` (the second SPA process) and
// `tests/helpers.ts` (what the specs open and seed against).
//
// One module because those ends have to AGREE, and a copy of `PORT + 2` in one of them beside an
// `E2E_AUTH_PORT` read in another is not a knob: the stack boots, every readiness probe passes, and a
// spec then fails deep inside itself on a connection error that names nothing. Every variable below
// is honoured exactly once.
//
// This file imports NOTHING on purpose: `authFrontend.mjs` runs it through Node's TypeScript
// stripping with no build step, so it must resolve no workspace package.

/** A port from an env var, falling back when unset or blank. */
const port = (value: string | undefined, fallback: number): number =>
  value === undefined || value.trim() === '' ? fallback : Number(value)

/**
 * The port an origin binds.
 *
 * A `*_URL` override has to move the LISTENER as well as the callers: pointing the specs at one
 * origin while the suite starts a server on another is the desync this module exists to make
 * unrepresentable. When the URL names a host the suite does not serve, Playwright reuses what is
 * already answering there and the derived port is never bound.
 */
const portOf = (url: string): number => {
  const parsed = new URL(url)
  if (parsed.port) return Number(parsed.port)
  return parsed.protocol === 'https:' ? 443 : 80
}

/** The primary backend (`TESTING_NO_AUTH`): the surface every spec seeds and triggers over REST. */
export const BACKEND_PORT = port(process.env.PORT, 8787)
export const BACKEND_URL = process.env.E2E_BACKEND_URL ?? `http://localhost:${BACKEND_PORT}`

/** The primary SPA (the production build served by `nuxt preview`). */
export const FRONTEND_PORT = port(process.env.E2E_FRONTEND_PORT, 3000)
export const FRONTEND_URL = process.env.E2E_FRONTEND_URL ?? `http://localhost:${FRONTEND_PORT}`

/**
 * The test-only control channel: a separate listener, so it never couples to the app's CORS/auth.
 * Defaults beside the backend it belongs to, which is why the primary port drives the whole set.
 */
export const CONTROL_PORT = port(process.env.E2E_CONTROL_PORT, BACKEND_PORT + 1)
export const CONTROL_URL = process.env.E2E_CONTROL_URL ?? `http://localhost:${CONTROL_PORT}`

/**
 * The AUTH-ENABLED stack: a second HTTP surface over the same backend process (`authBackend.ts`)
 * plus a second instance of the same SPA build pointed at it (`authFrontend.mjs`). Both default
 * beside their primary counterparts, so overriding `PORT` / `E2E_FRONTEND_PORT` moves the whole set
 * and can never collide with it.
 */
export const AUTH_BACKEND_URL =
  process.env.E2E_AUTH_BACKEND_URL ??
  `http://localhost:${port(process.env.E2E_AUTH_PORT, BACKEND_PORT + 2)}`
export const AUTH_BACKEND_PORT = port(process.env.E2E_AUTH_PORT, portOf(AUTH_BACKEND_URL))

export const AUTH_FRONTEND_URL =
  process.env.E2E_AUTH_FRONTEND_URL ??
  `http://localhost:${port(process.env.E2E_AUTH_FRONTEND_PORT, FRONTEND_PORT + 1)}`
export const AUTH_FRONTEND_PORT = port(
  process.env.E2E_AUTH_FRONTEND_PORT,
  portOf(AUTH_FRONTEND_URL),
)
