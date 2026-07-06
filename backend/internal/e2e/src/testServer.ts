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
import { createServer } from 'node:http'
import { AsyncFakeAgentExecutor } from '@cat-factory/conformance'
import { buildNodeContainer, start } from '@cat-factory/node-server'
import { fakeInlineModelResolver } from './fakeInlineModel.ts'
import { E2eFakeAgentExecutor, E2eRepoBootstrapper, type FakeProfile } from './fakeProfile.ts'

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

// The BASE fake options every workspace inherits (the historical global env knobs). A spec
// overrides these PER WORKSPACE via the control channel below; a workspace with no profile
// gets exactly these, so the pre-existing specs are unchanged.
const baseOptions: FakeOptions = {
  confidence,
  decisionOnSteps,
  ...(asyncKinds.length || dispatchThrowKinds.length
    ? {
        // A thrown dispatch is only meaningful for an async (polled) kind.
        asyncKinds: [...new Set([...asyncKinds, ...dispatchThrowKinds])] as FakeKind[],
        dispatchThrowKinds,
      }
    : {}),
}

// The per-workspace fake-behaviour registry, mutated by the test-only control server below and
// read by the two profile-aware wrappers. Keyed by workspace id.
const profiles = new Map<string, FakeProfile>()
const agentExecutor = new E2eFakeAgentExecutor(baseOptions, profiles)
const repoBootstrapper = new E2eRepoBootstrapper(profiles)

// A tiny, test-ONLY HTTP control channel (a separate listener, so it never couples to the
// shared Hono app or its CORS/auth). A spec `POST`s `{ workspaceId, profile }` from Node
// (Playwright's request context — not the browser), keyed to its own freshly-seeded
// workspace, BEFORE it starts the run. Listens on `PORT + 1` (or `E2E_CONTROL_PORT`) — the
// SAME derivation the `setFakeProfile` helper uses, so PORT drives both ends. Bound to
// loopback: it's reached only from the local Playwright process, never publicly.
const controlPort = Number(process.env.E2E_CONTROL_PORT ?? Number(process.env.PORT ?? '8787') + 1)
const controlServer = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/fake-profile') {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          workspaceId: string
          profile: FakeProfile
        }
        profiles.set(body.workspaceId, body.profile ?? {})
        res.writeHead(204).end()
      } catch (err) {
        res.writeHead(400).end(err instanceof Error ? err.message : String(err))
      }
    })
    return
  }
  res.writeHead(404).end()
})
// Fail LOUDLY if the control port can't be bound (e.g. a stale process on `PORT + 1`):
// crash the boot with a clear message rather than letting an unhandled `error` event take
// the process down opaquely — every profile-dependent spec would otherwise silently run on
// base behaviour.
controlServer.on('error', (err) => {
  console.error(`[e2e] fake-profile control channel failed to bind on ${controlPort}:`, err)
  process.exit(1)
})
controlServer.listen(controlPort, '127.0.0.1')

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
  // Poll durable async work every second instead of the 15s/30s production cadence: an async
  // agent kind's `awaiting_job` loop, a gate, AND the bootstrap drive (which polls at
  // `JOB_POLL_INTERVAL` too) all settle well within the suite's LIVE/RUN_TERMINAL timeouts.
  // Inline specs don't poll, so this is a no-op for them; the fakes are deterministic, so a
  // faster cadence changes no outcome.
  JOB_POLL_INTERVAL: process.env.JOB_POLL_INTERVAL ?? '1 second',
  CI_POLL_INTERVAL: process.env.CI_POLL_INTERVAL ?? '1 second',
  // Tick the initiative-execution loop every second instead of the 60s production backstop, so
  // an initiative that reaches `executing` spawns its first decorated task within the suite's
  // RUN_TERMINAL timeout (the planning run's terminal does NOT poke the loop — only the periodic
  // sweep spawns the first wave, so a slow cadence would time the spec out).
  INITIATIVE_LOOP_INTERVAL_MS: process.env.INITIATIVE_LOOP_INTERVAL_MS ?? '1000',
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? ENCRYPTION_KEY,
  // Raise the Postgres pool ceiling above node-postgres' default of 10. This single process serves
  // the WHOLE suite — every spec's HTTP calls, the durable execution worker, AND the 1s
  // initiative-loop sweep all share this one pool — so under the accumulated load of a shard's runs
  // a default-size pool can serialize their DB work and starve the sweep, landing an initiative's
  // first spawn past the spec's timeout (an intermittent "spawned card never appears"). Extra
  // headroom keeps the loop responsive; CI Postgres allows 100 connections.
  DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX ?? '40',
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
  // `realtimeSink` (so the REAL NodeEventPublisher pushes live events to the browser); we
  // only add the overrides, so everything else stays production.
  buildContainer: (opts) =>
    buildNodeContainer({
      ...opts,
      overrides: {
        agentExecutor,
        repoBootstrapper,
        // Fake the INLINE LLM path too (the agent executor above only fakes CONTAINER steps). The
        // full-interview `pl_initiative` pipeline runs its interviewer inline through this resolver;
        // on the keyless e2e backend the real resolver would fault it, so serve a converging mock.
        // See `fakeInlineModel.ts` — safe for existing specs (none assert on an inline-gate outcome).
        modelProviderResolver: fakeInlineModelResolver,
      },
      // The built-in default model preset points every agent kind at a Cloudflare-served
      // model, so the execution start guard needs that provider marked available to start a
      // run. The fake agent never actually calls a model. Mirrors the conformance harness.
      cloudflareModelsEnabled: true,
    }),
})
