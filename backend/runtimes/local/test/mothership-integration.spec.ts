import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeAgentExecutor } from '@cat-factory/conformance'
import {
  type DrizzleDb,
  buildNodeContainer,
  createApp as createNodeApp,
} from '@cat-factory/node-server'
import { HmacSigner, TOKEN_AUDIENCE } from '@cat-factory/server'
import type { Account, ExecutionInstance, WorkspaceSnapshot } from '@cat-factory/kernel'
import type { Pipeline } from '@cat-factory/contracts'
import { buildLocalContainer } from '../src/container.js'
import { setupTestDb } from './harness.js'
import {
  ENCRYPTION_KEY,
  SESSION_SECRET,
  buildMothershipEnv,
  mintMachineToken,
} from './mothership/setup.js'

// ---------------------------------------------------------------------------
// Mothership-mode functional integration test — the Phase 3 MERGE GATE
// (docs/initiatives/mothership-mode.md).
//
// Where `mothership.test.ts` proves the no-Postgres container *composes and boots*
// (build-only, stubbed fetch), this spec proves it is *functional end-to-end* against a
// REAL RPC backend: a no-Postgres local node loads a board and drives a run to a persisted
// terminal state, with every org/durable read+write travelling over the real
// `/internal/persistence` machine API to a hosted mothership.
//
// Topology (no mocks on the RPC path — a real HTTP loopback):
//   - The MOTHERSHIP is a stock Node facade (`buildNodeContainer`) over real Postgres,
//     served on a 127.0.0.1 loopback port. It owns the org/durable state and serves
//     `POST /internal/persistence` (machine-token gated, allow-list + account scope).
//   - The LOCAL node is a mothership-mode `buildLocalContainer` with NO database
//     (`db: undefined`): its `CoreRepositories` are the RPC-backed remote registry pointing
//     at the loopback mothership, and runs drive in-process via the durable `SqliteWorkRunner`
//     (backed by an in-memory local work queue).
//
// Only the agent executor is faked (the deterministic `FakeAgentExecutor`); the persistence
// path is entirely real, so an un-allow-listed repo method, a mis-scoped call, or a
// direct-db store that was never routed remotely fails THIS test instead of a developer's
// first board load.
// ---------------------------------------------------------------------------

// The mothership is a plain Node backend: real Postgres + the machine API. It does NOT run
// in dev-open / local mode — it just answers persistence RPC for the local node. The org
// authority carries the SAME integrations the local node delegates to it (documents / tasks /
// environments / fragments), so its repository registry actually wires those repos — a remote
// call to one otherwise comes back `... is not wired`. `buildMothershipEnv` (shared with the
// conformance harness) sets `AUTH_PASSWORD_ENABLED` so a hosted backend with no anonymous tier
// satisfies `loadNodeConfig`'s boot guard without being dev-open (the test only ever calls its
// machine-token RPC; seeding goes through its services).
const MOTHERSHIP_ENV: NodeJS.ProcessEnv = buildMothershipEnv()

const ORG_OWNER = { id: 'usr_org-owner', login: 'org-owner', name: 'Org Owner' }

// The execution status enum is `running | blocked | done | paused | failed`; `done` is the
// success terminal, `running`/`paused` are the only active states (what `driveWorkspace` re-drives).
const TERMINAL: ReadonlySet<ExecutionInstance['status']> = new Set([
  'done',
  'failed',
  'blocked',
] as ExecutionInstance['status'][])

describe('mothership mode — functional integration (real RPC backend)', () => {
  let db: DrizzleDb
  let server: ReturnType<typeof serve>
  let mothershipUrl: string
  let account: Account
  let workspaceId: string
  let machineToken: string
  // The mothership app (loopback) — kept so tests can call its mint endpoint directly.
  let mothershipApp: ReturnType<typeof createNodeApp>
  // The mothership-mode local node, with no database, talking to the loopback mothership.
  let local: ReturnType<typeof buildNodeApp>

  /** Mint a mothership SESSION token for `user` (aud: session), as the OAuth callback would. */
  function mintSession(user: { id: string; login: string; name: string | null }): Promise<string> {
    return new HmacSigner(SESSION_SECRET).sign({
      ...user,
      avatarUrl: null,
      email: null,
      aud: TOKEN_AUDIENCE.session,
      exp: Date.now() + 60_000,
    })
  }

  // Build the local mothership-mode app over the running loopback mothership. A deterministic
  // FakeAgentExecutor stands in for real containers; everything else is the real local wiring.
  function buildNodeApp(token: string | undefined = machineToken) {
    const container = buildLocalContainer({
      // No Postgres on the laptop: org/durable state is remote, credentials are local sqlite.
      env: {
        ...process.env,
        AUTH_DEV_OPEN: 'true',
        AUTH_PASSWORD_ENABLED: 'false',
        ENVIRONMENT: 'test',
        ENCRYPTION_KEY,
        AUTH_SESSION_SECRET: SESSION_SECRET,
        LOCAL_MOTHERSHIP_URL: mothershipUrl,
        // Omitted (undefined) for the connect-flow test: the node boots inert and acquires its
        // token via `/local/mothership/connect` instead of a static env token.
        LOCAL_MOTHERSHIP_TOKEN: token,
        LOCAL_MOTHERSHIP_CREDENTIAL_DB: ':memory:',
        LOCAL_MOTHERSHIP_WORK_DB: ':memory:',
        LOCAL_MOTHERSHIP_TOKEN_DB: ':memory:',
        // The ephemeral-environment integration wires from ENCRYPTION_KEY (always set here),
        // so `createCore` builds the provisioning service — that is what makes
        // `AgentContextBuilder` actually resolve the block's environment per dispatch
        // (`environmentRegistryRepository.getByBlock`, which returns null when none is
        // provisioned) over the RPC. Without the key the env repos route remotely but are
        // never reached on the run path, so the remote `getByBlock` read would be unit-tested
        // only, never exercised end-to-end. The mothership assembles it the same way.
      },
      overrides: { agentExecutor: new FakeAgentExecutor() },
      // The built-in default model preset routes every kind to a Cloudflare-served model, so the
      // execution start guard needs that provider available to start a run (parity with the
      // conformance harness). The FakeAgentExecutor still does the actual "work".
      cloudflareModelsEnabled: true,
    })
    const app = createNodeApp(container, { ...process.env, AUTH_DEV_OPEN: 'true' })
    async function call<T>(method: string, path: string, body?: unknown) {
      const hasBody = body !== undefined
      const res = await app.fetch(
        new Request(`https://local.test${path}`, {
          method,
          headers: hasBody ? { 'content-type': 'application/json' } : undefined,
          body: hasBody ? JSON.stringify(body) : undefined,
        }),
      )
      const text = await res.text()
      return { status: res.status, body: (text ? JSON.parse(text) : null) as T }
    }
    return { container, call }
  }

  beforeAll(async () => {
    db = await setupTestDb()

    // The mothership backend + its machine API, over real Postgres.
    const mothership = buildNodeContainer({ db, env: MOTHERSHIP_ENV })
    mothershipApp = createNodeApp(mothership, MOTHERSHIP_ENV)

    // Seed an ORG-owned workspace with the demo board directly on the mothership (dev-open has
    // no signed-in user, so go through the services, exactly like the conformance org helper).
    account = await mothership.accountService.createOrg(ORG_OWNER, { name: 'Mothership org' })
    const snapshot = (await mothership.workspaceService.create(
      { name: 'Mothership board', seed: true },
      ORG_OWNER.id,
      account.id,
    )) as WorkspaceSnapshot
    workspaceId = snapshot.workspace.id

    // The machine token the local node presents on every RPC: audience-pinned `machine`,
    // scoped to the seeded account, signed with the mothership's session secret.
    machineToken = (
      await mintMachineToken(SESSION_SECRET, {
        userId: ORG_OWNER.id,
        accountIds: [account.id],
        nodeId: 'node_integration-test',
      })
    ).token

    // Serve the mothership on an ephemeral loopback port (a REAL HTTP backend for the RPC).
    mothershipUrl = await new Promise<string>((resolve) => {
      server = serve(
        { fetch: mothershipApp.fetch, port: 0, hostname: '127.0.0.1' },
        (info: AddressInfo) => resolve(`http://127.0.0.1:${info.port}`),
      )
    })

    local = buildNodeApp()
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve()
      server.close(() => resolve())
    })
  })

  it('loads a board over the remote persistence RPC', async () => {
    const res = await local.call<WorkspaceSnapshot>('GET', `/workspaces/${workspaceId}`)
    expect(res.status).toBe(200)
    // The snapshot was assembled entirely from remote reads (workspace/blocks/services/mounts/
    // settings/presets/notifications/…), so a present, fully-populated board proves the read
    // surface round-trips through the allow-list with the right account scope.
    expect(res.body.workspace.id).toBe(workspaceId)
    const blockIds = res.body.blocks.map((b) => b.id)
    expect(blockIds).toContain('blk_auth')
    expect(blockIds).toContain('task_login')
    expect(res.body.executions).toHaveLength(0)
  })

  it('drives a run to a persisted terminal state over the remote persistence RPC', async () => {
    // Give the task a description that NAMES external references (a URL, a Jira key, a
    // fully-qualified GitHub ref) so `AgentContextBuilder` resolves each against the imported
    // corpus on dispatch — exercising the point-lookup run-path reads (`taskRepository.get` /
    // `getByUrl`, `documentRepository.getByUrl`) over the RPC, not just `listByBlock`. Nothing
    // is actually imported, so they resolve to nothing; the point is that each method is
    // allow-listed and round-trips (an un-allow-listed one would fail the run with
    // `unknown_method`). The patch itself is `blockRepository.update` over the RPC.
    const patched = await local.call('PATCH', `/workspaces/${workspaceId}/blocks/task_login`, {
      description:
        'Issue a session on valid credentials. Spec: https://example.com/spec — see PROJ-123 and acme/repo#7.',
    })
    expect(patched.status).toBe(200)

    // A minimal one-step pipeline (created over the RPC: pipelineRepository.insert).
    const pipeline = await local.call<Pipeline>('POST', `/workspaces/${workspaceId}/pipelines`, {
      name: 'Code only',
      agentKinds: ['coder'],
    })
    expect(pipeline.status).toBe(201)

    // Start a run on a seeded task (executionRepository.upsert + blockRepository.update over RPC).
    // In mothership mode the durable SqliteWorkRunner drives it immediately, in-process, reading
    // and writing every execution rev back through the RPC's optimistic-concurrency contract.
    const start = await local.call<{ id: string }>(
      'POST',
      `/workspaces/${workspaceId}/blocks/task_login/executions`,
      { pipelineId: pipeline.body.id },
    )
    expect(start.status).toBe(201)

    // Poll the snapshot (a remote read each time) until the run settles to a terminal status.
    // Bounded by a wall-clock deadline rather than a fixed iteration count so a slower CG/CI
    // box (each poll is a real Postgres RPC round-trip) doesn't spuriously time out the run.
    let execution: ExecutionInstance | undefined
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const snap = await local.call<WorkspaceSnapshot>('GET', `/workspaces/${workspaceId}`)
      execution = snap.body.executions.find((e) => e.blockId === 'task_login')
      if (execution && TERMINAL.has(execution.status)) break
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(execution, 'a run for task_login should exist').toBeDefined()
    expect(execution!.status).toBe('done')

    // The terminal run is persisted on the MOTHERSHIP (Postgres), not on the laptop — read it
    // back straight from the mothership's own execution repository to prove durability landed
    // on the hosted side, through the full RPC write path.
    const persisted = (await buildNodeContainer({
      db,
      env: MOTHERSHIP_ENV,
    }).executionRepository.getByBlock(workspaceId, 'task_login')) as ExecutionInstance | null
    expect(persisted?.status).toBe('done')
  })

  it('resolves an agent run kind over the remote RPC for the retry/stop surface', async () => {
    // The board's run controls (retry/stop) enter through `agentRunRepository.getRef`, the method
    // this slice allow-listed. Prove it round-trips end-to-end: in mothership mode
    // `container.agentRunRepository` IS the remote proxy, so `getRef` necessarily travels over the
    // RPC. The prior test drove task_login's run to `done`; retrying a non-failed run must resolve
    // its kind (execution) over the RPC and THEN be refused by the engine with 409
    // `run_not_retryable` — a non-allow-listed `getRef` would instead surface as an `unknown_method`
    // error (a 5xx), so the clean 409 proves the read reached the mothership and returned a ref.
    const snap = await local.call<WorkspaceSnapshot>('GET', `/workspaces/${workspaceId}`)
    const run = snap.body.executions.find((e) => e.blockId === 'task_login')
    expect(run?.status).toBe('done')

    const retry = await local.call<{ error?: { code?: string; details?: { reason?: string } } }>(
      'POST',
      `/workspaces/${workspaceId}/agent-runs/${run!.id}/retry`,
    )
    expect(retry.status).toBe(409)
    // A `ConflictError` serialises as `code: 'conflict'` with the specific reason under details.
    expect(retry.body.error?.code).toBe('conflict')
    expect(retry.body.error?.details?.reason).toBe('run_not_retryable')

    // An unknown run id: `getRef` returns null over the RPC (the null round-trips through the
    // tagged envelope), so the controller 404s — never a scope leak, never a 5xx.
    const unknown = await local.call(
      'POST',
      `/workspaces/${workspaceId}/agent-runs/ex_does-not-exist/retry`,
    )
    expect(unknown.status).toBe(404)
  })

  it('mints a machine token from a whitelisted session (scoped to the user accounts)', async () => {
    // A mothership SESSION for the org owner — as the OAuth callback would produce.
    const session = await mintSession(ORG_OWNER)
    const res = await mothershipApp.fetch(
      new Request(`${mothershipUrl}/auth/machine-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` },
        body: JSON.stringify({ nodeId: 'node_minted' }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; accountIds: string[]; user: { id: string } }
    // The owner is a member of the seeded org account (+ their personal account) — the org must
    // be in scope, so the minted token can load the org board.
    expect(body.accountIds).toContain(account.id)
    expect(body.user.id).toBe(ORG_OWNER.id)

    // The MINTED token satisfies the persistence RPC end-to-end: a fresh local node using it as
    // its machine token loads the org board.
    const mintedNode = buildNodeApp(body.token)
    const board = await mintedNode.call<WorkspaceSnapshot>('GET', `/workspaces/${workspaceId}`)
    expect(board.status).toBe(200)
    expect(board.body.workspace.id).toBe(workspaceId)
  })

  it('connects a token-less node via /local/mothership/connect (SPA login flow)', async () => {
    // A node that booted with NO static token — inert until it connects.
    const node = buildNodeApp(undefined)

    // The SPA captured a mothership session (OAuth fragment) and hands it to its own node.
    const session = await mintSession(ORG_OWNER)
    const connected = await node.call<{
      accountIds: string[]
      session: string
      user: { id: string }
    }>('POST', '/local/mothership/connect', { session })
    expect(connected.status).toBe(200)
    expect(connected.body.accountIds).toContain(account.id)
    // The node minted its OWN local session for the same user, so the SPA is signed in locally.
    expect(connected.body.user.id).toBe(ORG_OWNER.id)
    expect(connected.body.session).toBeTruthy()

    // With the token now cached, the SAME node loads the board over the RPC.
    const board = await node.call<WorkspaceSnapshot>('GET', `/workspaces/${workspaceId}`)
    expect(board.status).toBe(200)
    expect(board.body.workspace.id).toBe(workspaceId)
  })

  it('rejects a connect with a forged session (bad secret)', async () => {
    const node = buildNodeApp(undefined)
    const forged = await new HmacSigner('not-the-mothership-secret').sign({
      id: ORG_OWNER.id,
      login: ORG_OWNER.login,
      name: ORG_OWNER.name,
      avatarUrl: null,
      email: null,
      aud: TOKEN_AUDIENCE.session,
      exp: Date.now() + 60_000,
    })
    const res = await node.call('POST', '/local/mothership/connect', { session: forged })
    expect(res.status).toBe(403)
  })
})
