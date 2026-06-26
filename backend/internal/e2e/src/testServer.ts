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
import { FakeAgentExecutor, FakeRepoBootstrapper } from '@cat-factory/conformance'
import { buildNodeContainer, start } from '@cat-factory/node-server'

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

// A non-secret, fixed encryption key (32 zero bytes, base64). The always-on task-source
// integration makes config load require ENCRYPTION_KEY; a fixed value keeps any encrypted
// rows decryptable across restarts within a suite run. Never used for anything sensitive.
const ENCRYPTION_KEY = Buffer.alloc(32).toString('base64')

const env: NodeJS.ProcessEnv = {
  ...process.env,
  // Open the auth gate (dev-open) and pin a non-production ENVIRONMENT so it's honoured —
  // the SPA then renders the board with no login. Mirrors the conformance test env.
  AUTH_DEV_OPEN: 'true',
  ENVIRONMENT: 'test',
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? ENCRYPTION_KEY,
  PORT: process.env.PORT ?? '8787',
  // The SPA is served from a different origin (the Nuxt dev server), so the browser's
  // cross-origin REST calls need this allow-listed. The WebSocket upgrade is authorised
  // by ticket, not CORS.
  CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:3000',
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
        agentExecutor: new FakeAgentExecutor({ confidence: 1, decisionOnSteps }),
        repoBootstrapper: new FakeRepoBootstrapper(),
      },
      // The built-in default model preset points every agent kind at a Cloudflare-served
      // model, so the execution start guard needs that provider marked available to start a
      // run. The fake agent never actually calls a model. Mirrors the conformance harness.
      cloudflareModelsEnabled: true,
    }),
})
