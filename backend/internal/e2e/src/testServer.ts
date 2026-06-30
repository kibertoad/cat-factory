// The e2e backend: a REAL Node facade — the same shared Hono app, real Postgres
// (Drizzle), real pg-boss durable execution and the real WebSocket push transport —
// with only the EXTERNAL dependencies faked so the suite is deterministic and needs
// no secrets, no Docker and no network:
//
//   - LLMs + per-run agent containers  → the canonical deterministic FakeAgentExecutor
//     (the same one the cross-runtime conformance suite drives). No LLM HTTP, no Docker.
//   - repo bootstrap                   → FakeRepoBootstrapper (no GitHub, no container).
//   - GitHub App / email / Slack / Datadog → left OFF (all opt-in; the server boots and
//     the board renders without them, and the gates/providers pass through).
//
// Everything else is production: the controllers, the auth gate (open in dev), the
// durable pg-boss execution worker + sweepers, and the per-workspace real-time hub that
// pushes execution/board/notification events to subscribed browsers. So a run started
// over REST advances durably and the SPA updates LIVE over the WebSocket — exactly as in
// production, just with a fake agent doing the "work".
//
// Run directly via Node type stripping: `node src/testServer.ts` (Playwright's webServer
// boots it). Reads `DATABASE_URL` (required) and a couple of optional knobs (below).
import {
  AsyncFakeAgentExecutor,
  FakeAgentExecutor,
  FakeRepoBootstrapper,
} from '@cat-factory/conformance'
import { buildNodeContainer, start } from '@cat-factory/node-server'

/** The options shape `AsyncFakeAgentExecutor`/`FakeAgentExecutor` accept (avoids importing
 * the kernel `AgentKind` type, which isn't a dependency of this test-only package). */
type FakeOptions = ConstructorParameters<typeof AsyncFakeAgentExecutor>[0]
type FakeKind = NonNullable<NonNullable<FakeOptions>['asyncKinds']>[number]

/**
 * Step indices (into the agent-executed steps of a run) at which the fake agent should
 * raise a one-shot human DECISION before completing — so the suite can exercise the
 * decision-gate flow (run parks → SPA badge appears live → human resolves → run resumes).
 * Defaults to `0` so the first agent step of every run parks once. Set to empty to
 * disable.
 */
const decisionOnSteps = (process.env.E2E_DECISION_ON_STEPS ?? '0')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map((s) => Number(s))
  .filter((n) => Number.isInteger(n))

/** Parse a comma-separated list of agent kinds from an env knob (empty ⇒ []). */
const parseKinds = (raw: string | undefined): FakeKind[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0) as FakeKind[]

// Agent kinds whose container dispatch should THROW (the runner never accepts the job),
// and/or kinds the fake should drive as a POLLED async job. When either is set the suite
// needs the ASYNC fake (so the engine's dispatch-failure / awaiting_job paths run); when
// both are empty the default (inline) FakeAgentExecutor is used so the existing specs are
// byte-identical. Used by the agent-failure spec via a dedicated webServer (see config).
const dispatchThrowKinds = parseKinds(process.env.E2E_DISPATCH_THROW_KINDS)
const asyncKinds = parseKinds(process.env.E2E_ASYNC_KINDS)

// Confidence the fake reports on the final step (drives auto-merge vs PR-ready). Default
// 1; lower it (e.g. for a merge-review flow) via E2E_CONFIDENCE.
const confidence = process.env.E2E_CONFIDENCE ? Number(process.env.E2E_CONFIDENCE) : 1

const agentExecutor =
  dispatchThrowKinds.length > 0 || asyncKinds.length > 0
    ? new AsyncFakeAgentExecutor({
        confidence,
        decisionOnSteps,
        // A thrown dispatch is only meaningful for an async (polled) kind, so any
        // dispatch-throw kind is implicitly async too.
        asyncKinds: [...new Set([...asyncKinds, ...dispatchThrowKinds])],
        dispatchThrowKinds,
      })
    : new FakeAgentExecutor({ confidence, decisionOnSteps })

// A non-secret, fixed encryption key (32 zero bytes, base64). The always-on task-source
// integration makes config load require ENCRYPTION_KEY; a fixed value keeps any encrypted
// rows decryptable across restarts within a suite run. Never used for anything sensitive.
const ENCRYPTION_KEY = Buffer.alloc(32).toString('base64')

const env: NodeJS.ProcessEnv = {
  ...process.env,
  // Run with NO authentication: `TESTING_NO_AUTH` opens the API gate (it implies dev-open)
  // AND tells the SPA it may render the board anonymously instead of gating to the login
  // screen (a remote facade otherwise has no anonymous tier). Pin a non-production
  // ENVIRONMENT so the flag is honoured. Mirrors the conformance test env.
  TESTING_NO_AUTH: 'true',
  ENVIRONMENT: 'test',
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? ENCRYPTION_KEY,
  PORT: process.env.PORT ?? '8787',
  // The SPA is served from a different origin (the Nuxt dev server), so the browser's
  // cross-origin REST calls need this allow-listed. The WebSocket upgrade is authorised
  // by ticket, not CORS. Playwright passes the SPA's exact origin (derived from
  // E2E_FRONTEND_PORT); the fallback below derives the same default so a standalone
  // `pnpm serve` stays consistent with the frontend's port.
  CORS_ALLOWED_ORIGINS:
    process.env.CORS_ALLOWED_ORIGINS ??
    `http://localhost:${process.env.E2E_FRONTEND_PORT ?? '3000'}`,
}

if (!env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is required to run the e2e backend (e.g. postgres://postgres:postgres@127.0.0.1:5432/cat_factory_test)',
  )
}

await start({
  env,
  // The composition root: the stock Node container, but with the agent executor + repo
  // bootstrapper swapped for the deterministic fakes. `start()` supplies `db`, the started
  // pg-boss `boss` (so the REAL durable runner drives runs — NOT the Noop runner) and the
  // `realtimeHub` (so the REAL NodeEventPublisher pushes live events to the browser); we
  // only add the overrides, so everything else stays production.
  buildContainer: (opts) =>
    buildNodeContainer({
      ...opts,
      overrides: {
        agentExecutor,
        repoBootstrapper: new FakeRepoBootstrapper(),
      },
      // The built-in default model preset points every agent kind at a Cloudflare-served
      // model, so the execution start guard needs that provider marked available to start a
      // run. The fake agent never actually calls a model. Mirrors the conformance harness.
      cloudflareModelsEnabled: true,
    }),
})
