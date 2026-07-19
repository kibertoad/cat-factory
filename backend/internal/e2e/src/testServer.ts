// The e2e backend: a REAL Node facade — the same shared Hono app, real Postgres
// (Drizzle), real pg-boss durable execution and the real WebSocket push transport —
// with only the EXTERNAL dependencies faked so the suite is deterministic and needs
// no secrets, no Docker and no network:
//
//   - LLMs + per-run agent containers  → the canonical deterministic FakeAgentExecutor
//     (the same one the cross-runtime conformance suite drives). No LLM HTTP, no Docker.
//   - repo bootstrap                   → FakeRepoBootstrapper (no GitHub, no container).
//   - GitHub App                       → faked ON with the canonical FakeGitHubClient + the
//     real Drizzle projection repos, wired through `overrides` with NO real credentials (see
//     fakeGitHub.ts). `seedGitHub` (control channel) connects a workspace with a repo + branches.
//   - email / Slack / Datadog          → left OFF (all opt-in; the server boots and the board
//     renders without them, and the gates/providers pass through).
//
// Everything else is production: the controllers, the auth gate (open in dev), the
// durable pg-boss execution worker + sweepers, and the per-workspace real-time hub that
// pushes execution/board/notification events to subscribed browsers. So a run started
// over REST advances durably and the SPA updates LIVE over the WebSocket — exactly as in
// production, just with a fake agent doing the "work".
//
// Run directly via Node type stripping: `node src/testServer.ts` (Playwright's webServer
// boots it). Reads `DATABASE_URL` (required) and a couple of optional knobs (below).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { AsyncFakeAgentExecutor, makeOnboardingProbe, mintSession } from '@cat-factory/conformance'
import {
  buildNodeContainer,
  DrizzleBranchProjectionRepository,
  DrizzleCheckRunProjectionRepository,
  DrizzleCommitProjectionRepository,
  type DrizzleDb,
  DrizzleGitHubInstallationRepository,
  DrizzleIssueProjectionRepository,
  DrizzlePullRequestProjectionRepository,
  DrizzleRepoProjectionRepository,
  DrizzleWorkspaceMemberRepository,
  DrizzleWorkspaceRepository,
  start,
} from '@cat-factory/node-server'
import { createE2eGitHubClient, type GitHubSeed, seedGitHubForWorkspace } from './fakeGitHub.ts'
import { fakeInlineModelResolver } from './fakeInlineModel.ts'
import {
  E2eFakeAgentExecutor,
  E2eGateProviders,
  E2eRepoBootstrapper,
  type FakeProfile,
} from './fakeProfile.ts'

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
  // A real code-producing pipeline (coder/build) opens a PR — so the fake reports one by
  // default. This is not cosmetic: `RunStateMachine.finalizeBlock` finalizes a merger-less
  // run to `pr_ready` (+ a `pipeline_complete` notification) ONLY when the block has a PR;
  // a run that produced NO PR takes the read-only/findings terminal path and finalizes
  // silently `done` (no notification). Without a default PR every run-to-terminal spec
  // (run/notifications/approval-gate/fork-decision/pipeline-progress/recurring-run) would
  // hit that no-PR path and never reach `pr_ready`/raise the inbox item they assert on. A
  // spec that needs a different PR (or the gate specs, which set their own) overrides it.
  pullRequest: { url: 'https://github.com/o/r/pull/1', number: 1, branch: 'feat/login' },
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
// The built-in gates (`ci`/`conflicts`/`post-release-health`) read their data source through a
// wired provider; unwired they pass through (as today). Wiring these per-workspace fakes lets a
// spec drive the real gate → helper-agent engine loop (red CI → ci-fixer → green, a conflicted
// PR → conflict-resolver, a regressed release → on-call). They only run when a pipeline includes
// the gate step, so the pre-existing specs are unaffected.
const gateProviders = new E2eGateProviders(profiles)

// GitHub App integration, faked ON with NO real credentials (see fakeGitHub.ts). The shared
// catalogued fake client backs the interactive connect/link flows; per-workspace connection +
// projection state is seeded directly over the `/github-seed` control route below. `db` is only
// available inside `buildContainer`, so it's captured there and read by that route (which only
// fires after boot). Both are consumed by controllers, so one shared client is safe.
const githubClient = createE2eGitHubClient()
let seedDb: DrizzleDb | null = null

// Auth-enabled seam for the workspace-RBAC e2e (rbac.spec.ts). The shared backend keeps
// TESTING_NO_AUTH on — so an ANONYMOUS request stays dev-open and every existing spec is
// byte-identical — while ALSO configuring a session secret. A request bearing a signed
// session token then resolves to its user and the workspace-RBAC gate enforces per-user
// access (the gate keys on the SECRET's presence, not `config.auth.enabled`, which stays
// false because no OAuth/password provider is configured). The RBAC spec mints tokens over
// the `/rbac-seed` control route below and injects them into the SPA's persisted `auth`
// store, exactly as `pinWorkspace` injects the picked workspace id.
const AUTH_SESSION_SECRET =
  process.env.AUTH_SESSION_SECRET ?? 'e2e-workspace-rbac-session-secret-0123456789'
// The built container, captured for the `/rbac-seed` control route (which needs the real
// user / account / workspace services). Only read AFTER boot, so it is set by the time a
// spec calls the route.
let rbacContainer: ReturnType<typeof buildNodeContainer> | null = null

/**
 * Seed a restricted-board RBAC scenario and mint signed sessions for it, over the control
 * channel (there is no anonymous REST path to create users / account members). Mirrors the
 * cross-runtime `defineWorkspaceRbacSuite` fixture: an org owned by admin A, a developer B
 * enrolled in the account and scoped to the board as a `viewer`, and the board flipped to
 * `restricted`. The board is created with a NULL owner (no creator auto-enroll), so A's full
 * access comes purely from the account-admin escape hatch. Returns the board id + a Bearer
 * token and user id for each principal, which the spec injects into the SPA.
 */
async function seedRbacScenario(
  container: NonNullable<typeof rbacContainer>,
  db: DrizzleDb,
  tag: string,
): Promise<{
  workspaceId: string
  adminToken: string
  adminUserId: string
  viewerToken: string
  viewerUserId: string
}> {
  const probe = makeOnboardingProbe(container)
  const { accountId, ownerUserId: adminUserId } = await probe.makeOrgOwner(`rbac-${tag}`)
  const viewer = await probe.users.findOrCreateByIdentity('github', `rbac-viewer-${tag}`, {
    name: 'RBAC Viewer',
    email: `rbac-viewer-${tag}@example.com`,
    emailVerified: true,
  })
  await probe.addAccountMember(accountId, adminUserId, viewer.id, ['developer'])
  // Seed the sample architecture (so the board carries the runnable `task_login` the SPA
  // readiness gate asserts on); null owner ⇒ no creator admin row.
  const snapshot = await container.workspaceService.create(
    { name: 'RBAC board', seed: true },
    null,
    accountId,
  )
  const workspaceId = snapshot.workspace.id
  // Connect the (faked) GitHub App for the board, or the SPA sits on the onboarding gate.
  await seedGitHubForWorkspace(db, workspaceId, {})
  // Scope B as a viewer and restrict the board (raw repos — the seed predates any request,
  // so nothing is cached to invalidate).
  await new DrizzleWorkspaceMemberRepository(db).upsert({
    workspaceId,
    userId: viewer.id,
    role: 'viewer',
    createdAt: Date.now(),
    addedByUserId: adminUserId,
  })
  await new DrizzleWorkspaceRepository(db).setAccessMode(workspaceId, 'restricted')
  const [adminToken, viewerToken] = await Promise.all([
    mintSession(AUTH_SESSION_SECRET, { id: adminUserId, login: `rbac-${tag}`, name: 'RBAC Admin' }),
    mintSession(AUTH_SESSION_SECRET, {
      id: viewer.id,
      login: `rbac-viewer-${tag}`,
      name: viewer.name,
    }),
  ])
  return { workspaceId, adminToken, adminUserId, viewerToken, viewerUserId: viewer.id }
}

// A tiny, test-ONLY HTTP control channel (a separate listener, so it never couples to the
// shared Hono app or its CORS/auth). A spec `POST`s `{ workspaceId, profile }` from Node
// (Playwright's request context — not the browser), keyed to its own freshly-seeded
// workspace, BEFORE it starts the run. Listens on `PORT + 1` (or `E2E_CONTROL_PORT`) — the
// SAME derivation the `setFakeProfile` helper uses, so PORT drives both ends. Bound to
// loopback: it's reached only from the local Playwright process, never publicly.
const controlPort = Number(process.env.E2E_CONTROL_PORT ?? Number(process.env.PORT ?? '8787') + 1)
// Reject on a socket error so a caller gets a fast 400 instead of a hung request that only
// surfaces as a spec timeout.
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

const fail = (res: ServerResponse, status: number, err: unknown): void => {
  res.writeHead(status).end(err instanceof Error ? err.message : String(err))
}

const controlServer = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/fake-profile') {
    void readBody(req)
      .then((raw) => {
        const body = JSON.parse(raw) as { workspaceId: string; profile: FakeProfile }
        profiles.set(body.workspaceId, body.profile ?? {})
        res.writeHead(204).end()
      })
      .catch((err) => fail(res, 400, err))
    return
  }
  // Seed a workspace's GitHub connection + repo/branch projections (see fakeGitHub.ts), so the
  // SPA loads a connected GitHub with repos + branches. Fired from a spec's Node request context
  // BEFORE it opens the board.
  if (req.method === 'POST' && req.url === '/github-seed') {
    void readBody(req)
      .then(async (raw) => {
        if (!seedDb) {
          res.writeHead(503).end('github seed: db not ready')
          return
        }
        const body = JSON.parse(raw) as { workspaceId: string; seed?: GitHubSeed }
        await seedGitHubForWorkspace(seedDb, body.workspaceId, body.seed ?? {})
        res.writeHead(204).end()
      })
      .catch((err) => fail(res, 400, err))
    return
  }
  // Seed a restricted-board RBAC scenario + mint the principals' sessions (see
  // `seedRbacScenario`). Returns the board id + a Bearer token per principal, which the RBAC
  // spec injects into the SPA to drive the board as an authenticated viewer vs admin.
  if (req.method === 'POST' && req.url === '/rbac-seed') {
    void readBody(req)
      .then(async (raw) => {
        if (!rbacContainer || !seedDb) {
          res.writeHead(503).end('rbac seed: container not ready')
          return
        }
        const body = JSON.parse(raw) as { tag: string }
        const result = await seedRbacScenario(rbacContainer, seedDb, body.tag)
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
      })
      .catch((err) => fail(res, 400, err))
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
  // Configure a session secret WITHOUT enabling any auth provider: anonymous requests stay
  // dev-open (existing specs unchanged), but a signed session token still resolves to its
  // user so the workspace-RBAC gate enforces per-user access for the RBAC spec (see the
  // `AUTH_SESSION_SECRET` note above). `config.auth.enabled` stays false (no provider), so
  // the SPA still renders anonymously by default under TESTING_NO_AUTH.
  AUTH_SESSION_SECRET: process.env.AUTH_SESSION_SECRET ?? AUTH_SESSION_SECRET,
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
  // Wire the release-health module (the observability connection repo + management API), so the
  // post-release-health spec can connect an observability provider and create a pipeline carrying
  // the observability-gated `post-release-health` step (rejected otherwise). The gate's runtime
  // verdict comes from the per-workspace fake ReleaseHealthProvider (E2eGateProviders), not a real
  // Datadog call — this only unlocks the pipeline-authoring gate + the connection seam.
  OBSERVABILITY_ENABLED: process.env.OBSERVABILITY_ENABLED ?? 'true',
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
  buildContainer: (opts) => {
    // `start()` always supplies the Drizzle `db`; capture it for the `/github-seed` control route
    // and build the GitHub projection repos over it. Wiring these + the fake client through
    // `overrides` turns the GitHub module ON with no real App (see fakeGitHub.ts).
    const db = opts.db
    if (!db) throw new Error('[e2e] expected start() to supply a Drizzle db')
    seedDb = db
    const container = buildNodeContainer({
      ...opts,
      overrides: {
        agentExecutor,
        repoBootstrapper,
        // Fake the INLINE LLM path too (the agent executor above only fakes CONTAINER steps). The
        // full-interview `pl_initiative` pipeline runs its interviewer inline through this resolver;
        // on the keyless e2e backend the real resolver would fault it, so serve a converging mock.
        // See `fakeInlineModel.ts` — safe for existing specs (none assert on an inline-gate outcome).
        modelProviderResolver: fakeInlineModelResolver,
        // GitHub App faked ON via overrides (no GITHUB_APP_ID/private key): the fake client + the
        // real Drizzle projection repos + a pass-through webhook verifier. The read endpoints serve
        // from the projections; `seedGitHubForWorkspace` populates them per workspace.
        githubClient,
        githubInstallationRepository: new DrizzleGitHubInstallationRepository(db),
        repoProjectionRepository: new DrizzleRepoProjectionRepository(db),
        branchProjectionRepository: new DrizzleBranchProjectionRepository(db),
        pullRequestProjectionRepository: new DrizzlePullRequestProjectionRepository(db),
        issueProjectionRepository: new DrizzleIssueProjectionRepository(db),
        commitProjectionRepository: new DrizzleCommitProjectionRepository(db),
        checkRunProjectionRepository: new DrizzleCheckRunProjectionRepository(db),
        webhookVerifier: { verify: async () => true },
      },
      // The built-in default model preset points every agent kind at a Cloudflare-served
      // model, so the execution start guard needs that provider marked available to start a
      // run. The fake agent never actually calls a model. Mirrors the conformance harness.
      cloudflareModelsEnabled: true,
      // Wire the per-workspace fake gate providers (applied AFTER the build's
      // `clearGateProviders()`), so a spec's gate-bearing pipeline drives the real gate loop.
      gateProviders: {
        ciStatus: gateProviders.ciStatus,
        mergeability: gateProviders.mergeability,
        releaseHealth: gateProviders.releaseHealth,
      },
    })
    // Capture the built container for the `/rbac-seed` control route (real user / account /
    // workspace services). Read only after boot, when a spec fires the route.
    rbacContainer = container
    return container
  },
})
