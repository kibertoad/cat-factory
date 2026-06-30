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
//     at the loopback mothership, and runs drive in-process via `InProcessWorkRunner`.
//
// Only the agent executor is faked (the deterministic `FakeAgentExecutor`); the persistence
// path is entirely real, so an un-allow-listed repo method, a mis-scoped call, or a
// direct-db store that was never routed remotely fails THIS test instead of a developer's
// first board load.
// ---------------------------------------------------------------------------

const SESSION_SECRET = 'mothership-integration-session-secret-0123456789'
const ENCRYPTION_KEY = Buffer.alloc(32).toString('base64')

// The mothership is a plain Node backend: real Postgres + the machine API. It does NOT run
// in dev-open / local mode — it just answers persistence RPC for the local node. The org
// authority carries the SAME integrations the local node delegates to it (documents / tasks /
// environments / fragments), so its repository registry actually wires those repos — a remote
// call to one otherwise comes back `... is not wired`. Mirrors the Node harness TEST_ENV.
const MOTHERSHIP_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  ENVIRONMENT: 'test',
  ENCRYPTION_KEY,
  // The shared secret the machine token is signed with and the mothership verifies against.
  AUTH_SESSION_SECRET: SESSION_SECRET,
  ENVIRONMENTS_ENABLED: 'true',
  PROMPT_LIBRARY_ENABLED: 'true',
  DOCUMENT_SOURCES: 'confluence,notion,github,figma,zeplin,linear',
}

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
  // The mothership-mode local node, with no database, talking to the loopback mothership.
  let local: ReturnType<typeof buildNodeApp>

  // Build the local mothership-mode app over the running loopback mothership. A deterministic
  // FakeAgentExecutor stands in for real containers; everything else is the real local wiring.
  function buildNodeApp() {
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
        LOCAL_MOTHERSHIP_TOKEN: machineToken,
        LOCAL_MOTHERSHIP_CREDENTIAL_DB: ':memory:',
        // Opt the local node into the ephemeral-environment integration so `createCore` builds
        // the provisioning service — that is what makes `AgentContextBuilder` actually resolve
        // the block's environment per dispatch (`environmentRegistryRepository.getByBlock`,
        // which returns null when none is provisioned) over the RPC. Without it the env repos
        // route remotely but are never reached on the run path, so the remote `getByBlock` read
        // would be unit-tested only, never exercised end-to-end. The mothership already enables
        // it (MOTHERSHIP_ENV), so the remote registry actually wires the repo.
        ENVIRONMENTS_ENABLED: 'true',
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
    const mothershipApp = createNodeApp(mothership, MOTHERSHIP_ENV)

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
    machineToken = await new HmacSigner(SESSION_SECRET).sign({
      aud: TOKEN_AUDIENCE.machine,
      nodeId: 'node_integration-test',
      userId: ORG_OWNER.id,
      scope: { accountIds: [account.id] },
      exp: Date.now() + 3_600_000,
    })

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
    // In mothership mode the InProcessWorkRunner drives it immediately, in-process, reading and
    // writing every execution rev back through the RPC's optimistic-concurrency contract.
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
})
