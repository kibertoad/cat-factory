import { allPullRequests } from '@cat-factory/contracts'
import {
  type Block,
  type ExecutionInstance,
  type ModelPreset,
  type Notification,
  type Pipeline,
  type WorkspaceSnapshot,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

// Core conformance, slice 4: the remaining workspace feature surfaces — per-workspace budget +
// incident-enrichment secrets, epics + the dependency graph, notifications, and model presets.
// Split out of the former monolithic `core.ts`; re-opens its `describe` groups inside the
// aggregator's `[name] conformance` wrapper (test tree unchanged).
export function defineCoreWorkspaceFeaturesConformance(harness: ConformanceHarness): void {
  describe('per-workspace budget + incident-enrichment secrets', () => {
    it('resolves a per-workspace budget set in settings, reflected in /spend (D1 ⇄ Postgres)', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      // No override ⇒ the built-in deployment default budget.
      const before = await call<{ costLimit: number; currency: string }>(
        'GET',
        `/workspaces/${wsId}/spend`,
      )
      expect(before.status).toBe(200)
      expect(before.body.costLimit).toBe(100)
      expect(before.body.currency).toBe('EUR')

      // Setting a per-workspace budget must take effect immediately — the initial GET
      // warmed the shared `workspaceSettings` cache slice (which SpendService's pricing
      // overlay reads through), and the settings write invalidates it — and round-trip
      // through the workspace_settings columns identically on both stores.
      const put = await call('PUT', `/workspaces/${wsId}/settings`, {
        spendMonthlyLimit: 250,
        spendCurrency: 'USD',
      })
      expect(put.status).toBe(200)

      const after = await call<{ costLimit: number; currency: string }>(
        'GET',
        `/workspaces/${wsId}/spend`,
      )
      expect(after.body.costLimit).toBe(250)
      expect(after.body.currency).toBe('USD')
    })

    it('round-trips the allowInitiatorPat credential policy (D1 ⇄ Postgres)', async () => {
      // The workspace's "may a run act as its initiator's own PAT?" switch. A boolean column
      // is exactly the shape that silently diverges between the two stores (D1 stores 0/1,
      // Postgres an integer we map back), and this one decides which CREDENTIAL a run pushes
      // with — so a facade that failed to persist it would leave an operator believing they
      // had turned the preference off. See backend/docs/security-model.md.
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const settings = `/workspaces/${workspace.id}/settings`

      const seeded = await call<{ allowInitiatorPat: boolean }>('GET', settings)
      expect(seeded.status).toBe(200)
      // Attribution is the shipped default, so a fresh workspace starts permissive.
      expect(seeded.body.allowInitiatorPat).toBe(true)

      const off = await call<{ allowInitiatorPat: boolean }>('PUT', settings, {
        allowInitiatorPat: false,
      })
      expect(off.status).toBe(200)
      expect(off.body.allowInitiatorPat).toBe(false)
      expect(
        (await call<{ allowInitiatorPat: boolean }>('GET', settings)).body.allowInitiatorPat,
      ).toBe(false)

      // And back on — `false` must not be a one-way door, and a patch that omits the field
      // must not silently reinstate the default over a deliberate choice.
      const untouched = await call<{ allowInitiatorPat: boolean }>('PUT', settings, {
        waitingEscalationMinutes: 33,
      })
      expect(untouched.body.allowInitiatorPat).toBe(false)
      const on = await call<{ allowInitiatorPat: boolean }>('PUT', settings, {
        allowInitiatorPat: true,
      })
      expect(on.body.allowInitiatorPat).toBe(true)
    })

    it('counts subscription usage in /usage but excludes it from the spend budget (D1 ⇄ Postgres)', async () => {
      type UsageRow = {
        billing: string
        vendor: string | null
        provider: string
        model: string
        inputTokens: number
        outputTokens: number
        costEstimate: number
        calls: number
      }
      type UsageReport = { periodStart: number; currency: string; rows: UsageRow[] }
      type Spend = { inputTokens: number; outputTokens: number; costSpent: number }

      // A subscription-harness run: the fake reports usage tagged 'subscription' (vendor
      // claude) — the proxy-bypassing Claude Code / Codex path.
      const sub = harness.makeApp({
        usage: { inputTokens: 1000, outputTokens: 500 },
        usageBilling: 'subscription',
        usageVendor: 'claude',
      })
      const subWs = (await sub.createWorkspace()).workspace.id
      const subPipe = await sub.call<Pipeline>('POST', `/workspaces/${subWs}/pipelines`, {
        name: 'Code',
        agentKinds: ['coder'],
      })
      const subStart = await sub.call('POST', `/workspaces/${subWs}/blocks/task_login/executions`, {
        pipelineId: subPipe.body.id,
      })
      expect(subStart.status).toBe(201)
      await sub.drive(subWs)

      const subUsage = await sub.call<UsageReport>('GET', `/workspaces/${subWs}/usage`)
      expect(subUsage.status).toBe(200)
      const subRow = subUsage.body.rows.find((r) => r.billing === 'subscription')
      expect(subRow).toBeDefined()
      expect(subRow?.vendor).toBe('claude')
      expect(subRow?.inputTokens).toBeGreaterThanOrEqual(1000)
      // The load-bearing invariant: a flat-rate subscription call is counted in the report
      // but NEVER in the spend budget (a quota plan costs nothing per token).
      expect(subUsage.body.rows.every((r) => r.billing === 'subscription')).toBe(true)
      const subSpend = await sub.call<Spend>('GET', `/workspaces/${subWs}/spend`)
      expect(subSpend.body.inputTokens).toBe(0)
      expect(subSpend.body.costSpent).toBe(0)

      // A metered run (same usage, default billing) IS counted by both the report and the budget.
      const met = harness.makeApp({ usage: { inputTokens: 1000, outputTokens: 500 } })
      const metWs = (await met.createWorkspace()).workspace.id
      const metPipe = await met.call<Pipeline>('POST', `/workspaces/${metWs}/pipelines`, {
        name: 'Code',
        agentKinds: ['coder'],
      })
      const metStart = await met.call('POST', `/workspaces/${metWs}/blocks/task_login/executions`, {
        pipelineId: metPipe.body.id,
      })
      expect(metStart.status).toBe(201)
      await met.drive(metWs)

      const metSpend = await met.call<Spend>('GET', `/workspaces/${metWs}/spend`)
      expect(metSpend.body.inputTokens).toBeGreaterThanOrEqual(1000)
      const metUsage = await met.call<UsageReport>('GET', `/workspaces/${metWs}/usage`)
      expect(metUsage.body.rows.some((r) => r.billing === 'metered')).toBe(true)
    })

    it('surfaces a spend-paused run as a workspace-scoped budget_paused card, cleared on resume (D1 ⇄ Postgres)', async () => {
      // F3 (stuck-run audit): a spend-`paused` run is invisible to the sweeper and has no
      // auto-resume, so the paused board badge used to be its ONLY signal. The pause must now
      // raise ONE workspace-scoped inbox card (persisted on whichever store the runtime uses),
      // and lifting the pause via /spend/resume must clear it — asserted on both D1 and Postgres.
      type Notif = { id: string; type: string; blockId: string | null; status: string }
      const app = harness.makeApp({ usage: { inputTokens: 1000, outputTokens: 500 } })
      const wsId = (await app.createWorkspace()).workspace.id

      // A tiny positive budget: the run STARTS (0 spend is within budget, so the up-front
      // start guard allows it) but the first metered step's usage pushes cumulative cost over
      // the limit, so the SECOND step pauses mid-run — the exact state the sweeper can't see.
      expect(
        (await app.call('PUT', `/workspaces/${wsId}/settings`, { spendMonthlyLimit: 0.0001 }))
          .status,
      ).toBe(200)

      const pipe = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Code',
        agentKinds: ['coder', 'documenter'],
      })
      const started = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipe.body.id,
      })
      expect(started.status).toBe(201)
      const driven = await app.drive(wsId)
      expect(driven.find((e) => e.blockId === 'task_login')?.status).toBe('paused')

      // Exactly one workspace-scoped (block-less) budget_paused card, open.
      const inbox = await app.call<Notif[]>('GET', `/workspaces/${wsId}/notifications`)
      const budget = inbox.body.filter((n) => n.type === 'budget_paused')
      expect(budget).toHaveLength(1)
      expect(budget[0]!.blockId).toBeNull()
      expect(budget[0]!.status).toBe('open')

      // Raise the budget and resume: the card is cleared and the run advances off `paused`.
      expect(
        (await app.call('PUT', `/workspaces/${wsId}/settings`, { spendMonthlyLimit: 1000 })).status,
      ).toBe(200)
      expect((await app.call('POST', `/workspaces/${wsId}/spend/resume`)).status).toBe(200)
      const resumed = await app.drive(wsId)
      expect(resumed.find((e) => e.blockId === 'task_login')?.status).not.toBe('paused')

      const after = await app.call<Notif[]>('GET', `/workspaces/${wsId}/notifications`)
      expect(after.body.some((n) => n.type === 'budget_paused' && n.status === 'open')).toBe(false)
    })

    it('round-trips the per-user (user-tier) budget (D1 ⇄ Postgres)', async () => {
      // The user-tier budget lives in the `user_settings` table (PK user_id). It is user-scoped,
      // so — like local model endpoints — it is exercised through the service directly (the
      // dev-open HTTP `call` path has no signed-in user). Asserts the new table round-trips a
      // nullable numeric identically on both stores.
      const app = harness.makeApp()
      const probe = app.userSettings?.()
      if (!probe) return
      const userId = 'usr_budget_conformance'

      const before = await probe.get(userId)
      expect(before.spendMonthlyLimit).toBeNull()

      const saved = await probe.update(userId, { spendMonthlyLimit: 42 })
      expect(saved.spendMonthlyLimit).toBe(42)
      expect((await probe.get(userId)).spendMonthlyLimit).toBe(42)

      // `0` is a real "no paid spend" limit, distinct from null (inherit/unlimited).
      await probe.update(userId, { spendMonthlyLimit: 0 })
      expect((await probe.get(userId)).spendMonthlyLimit).toBe(0)

      await probe.update(userId, { spendMonthlyLimit: null })
      expect((await probe.get(userId)).spendMonthlyLimit).toBeNull()
    })

    it('round-trips the local-mode delegation toggle + a paired boolean (D1 ⇄ Postgres)', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      type Settings = {
        delegateAgentsToRunnerPool: boolean
        kaizenEnabled: boolean
      }
      // Fresh-workspace defaults: agent delegation off (local-everything), Kaizen on.
      const initial = await call<Settings>('GET', `/workspaces/${wsId}/settings`)
      expect(initial.status).toBe(200)
      expect(initial.body.delegateAgentsToRunnerPool).toBe(false)
      expect(initial.body.kaizenEnabled).toBe(true)

      // Both flip and persist identically through the workspace_settings columns.
      const put = await call<Settings>('PUT', `/workspaces/${wsId}/settings`, {
        delegateAgentsToRunnerPool: true,
        kaizenEnabled: false,
      })
      expect(put.status).toBe(200)
      expect(put.body.delegateAgentsToRunnerPool).toBe(true)
      expect(put.body.kaizenEnabled).toBe(false)

      const reread = await call<Settings>('GET', `/workspaces/${wsId}/settings`)
      expect(reread.body.delegateAgentsToRunnerPool).toBe(true)
      expect(reread.body.kaizenEnabled).toBe(false)

      // A partial patch leaves the untouched flag intact (per-field merge).
      const partial = await call<Settings>('PUT', `/workspaces/${wsId}/settings`, {
        delegateAgentsToRunnerPool: false,
      })
      expect(partial.body.delegateAgentsToRunnerPool).toBe(false)
      expect(partial.body.kaizenEnabled).toBe(false)
    })

    it('round-trips the custom workspace metadata bag (D1 ⇄ Postgres)', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      type Settings = { metadata: Record<string, string>; kaizenEnabled: boolean }
      // A fresh workspace has filled nothing in — an empty object, never null: every reader
      // (an external-tool URL resolver above all) indexes it without a null check.
      const initial = await call<Settings>('GET', `/workspaces/${wsId}/settings`)
      expect(initial.status).toBe(200)
      expect(initial.body.metadata).toEqual({})

      // The bag is a JSON column on both stores, so this is where a store that stringified
      // or parsed it differently would diverge.
      const put = await call<Settings>('PUT', `/workspaces/${wsId}/settings`, {
        metadata: { gameId: 'zork', region: 'eu' },
      })
      expect(put.status).toBe(200)
      expect(put.body.metadata).toEqual({ gameId: 'zork', region: 'eu' })
      expect((await call<Settings>('GET', `/workspaces/${wsId}/settings`)).body.metadata).toEqual({
        gameId: 'zork',
        region: 'eu',
      })

      // Supplied ⇒ REPLACED: a field the editor cleared has to disappear, and a cleared value
      // drops its key rather than persisting as `''` (which would read as "set to nothing").
      const replaced = await call<Settings>('PUT', `/workspaces/${wsId}/settings`, {
        metadata: { gameId: 'myst', region: '  ' },
      })
      expect(replaced.body.metadata).toEqual({ gameId: 'myst' })

      // Omitted ⇒ untouched, like every other field's partial patch.
      const untouched = await call<Settings>('PUT', `/workspaces/${wsId}/settings`, {
        kaizenEnabled: false,
      })
      expect(untouched.body.metadata).toEqual({ gameId: 'myst' })

      // A key that isn't identifier-shaped is refused at the boundary rather than encoded on
      // its way into a tool URL.
      const rejected = await call('PUT', `/workspaces/${wsId}/settings`, {
        metadata: { 'not a key': 'x' },
      })
      expect(rejected.status).toBe(400)
    })

    it('round-trips incident-enrichment credentials, redacted + sealed (D1 ⇄ Postgres)', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      type View = {
        connected: boolean
        summary: { pagerDuty: boolean; incidentIo: boolean } | null
      }
      const initial = await call<View>('GET', `/workspaces/${wsId}/incident-enrichment`)
      // Wired only when the facade has the shared encryption key; skip otherwise.
      if (initial.status === 503) return
      expect(initial.status).toBe(200)
      expect(initial.body).toMatchObject({ connected: false, summary: null })

      const put = await call<View>('PUT', `/workspaces/${wsId}/incident-enrichment`, {
        pagerDuty: { apiToken: 'pd-secret-token', fromEmail: 'oncall@example.com' },
      })
      expect(put.status).toBe(200)
      expect(put.body.summary).toEqual({ pagerDuty: true, incidentIo: false })
      // The sealed token is NEVER surfaced on any read path.
      expect(JSON.stringify(put.body)).not.toContain('pd-secret-token')

      const view = await call<View>('GET', `/workspaces/${wsId}/incident-enrichment`)
      expect(view.body).toMatchObject({
        connected: true,
        summary: { pagerDuty: true, incidentIo: false },
      })
      expect(JSON.stringify(view.body)).not.toContain('pd-secret-token')

      const del = await call('DELETE', `/workspaces/${wsId}/incident-enrichment`)
      expect(del.status).toBe(204)
      const gone = await call<View>('GET', `/workspaces/${wsId}/incident-enrichment`)
      expect(gone.body).toMatchObject({ connected: false, summary: null })
    })
  })

  registerEpicDependencyTests(harness)

  registerNotificationAndPresetTests(harness)
}

/**
 * Epics and the block dependency graph.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerEpicDependencyTests(harness: ConformanceHarness): void {
  describe('epics + dependency graph', () => {
    it('round-trips an epic node + a task’s epic membership identically on every store', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      const epic = await call<Block>('POST', `/workspaces/${wsId}/epics`, {
        title: 'Checkout revamp',
        position: { x: 10, y: 20 },
      })
      expect(epic.status).toBe(201)
      expect(epic.body.level).toBe('epic')

      const task = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'Part of the epic',
      })
      const assigned = await call<Block>(
        'POST',
        `/workspaces/${wsId}/blocks/${task.body.id}/epic`,
        { epicId: epic.body.id },
      )
      expect(assigned.status).toBe(200)
      expect(assigned.body.epicId).toBe(epic.body.id)

      // Both the epic level and the membership link survive the store round-trip.
      const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      expect(snap.body.blocks.find((b) => b.id === epic.body.id)?.level).toBe('epic')
      expect(snap.body.blocks.find((b) => b.id === task.body.id)?.epicId).toBe(epic.body.id)
    })

    it('round-trips a service frame provisioning config (the JSON column) on every store', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      // The service-owned provisioning config (the "what + where") is a JSON object on the
      // service frame. A runtime that forgot to map the `provisioning` column drops it on
      // write — so this asserts it survives PATCH + a fresh snapshot read on D1 and Postgres.
      const provisioning = {
        type: 'docker-compose' as const,
        composePath: 'docker-compose.yml',
        localDevOnly: true,
      }
      const patched = await call<Block>('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, {
        provisioning,
      })
      expect(patched.status).toBe(200)
      expect(patched.body.provisioning).toEqual(provisioning)

      const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      expect(snap.body.blocks.find((b) => b.id === 'blk_auth')?.provisioning).toEqual(provisioning)
    })

    it('round-trips a frontend frame config (the JSON column + backend bindings) on every store', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      // A frontend frame's `frontendConfig` (build/serve/mock knobs + the backend bindings
      // that double as board links) is a JSON object on the frame block, mirroring
      // `provisioning`. A runtime that forgot to map the `frontend_config` column drops it on
      // write — so this asserts it survives PATCH + a fresh snapshot read on D1 and Postgres.
      const frontendConfig = {
        packageManager: 'pnpm' as const,
        buildScript: 'build',
        outputDir: 'dist',
        serveMode: 'static' as const,
        servePort: 8080,
        envInjection: 'build' as const,
        mockMappingsPath: 'mocks/',
        previewEnabled: true,
        backendBindings: [
          {
            envVar: 'PUB_BACKEND_URL',
            source: { kind: 'service' as const, serviceBlockId: 'blk_auth' },
          },
          { envVar: 'PUB_OTHER_URL', source: { kind: 'mock' as const } },
        ],
      }
      const patched = await call<Block>('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, {
        frontendConfig,
      })
      expect(patched.status).toBe(200)
      expect(patched.body.frontendConfig).toEqual(frontendConfig)

      const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      expect(snap.body.blocks.find((b) => b.id === 'blk_auth')?.frontendConfig).toEqual(
        frontendConfig,
      )
    })

    it('round-trips service connections + involved services (the JSON columns) on every store', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      // A service frame's `serviceConnections` (consumer→provider edges) and a task's
      // `involvedServiceIds` are JSON columns on the block, mirroring `frontend_config`.
      // A runtime that forgot to map either column drops it on write — so this asserts
      // both survive PATCH + a fresh snapshot read on D1 and Postgres. The seed has one
      // service-type frame (blk_auth), so create the provider frame to connect to.
      const provider = await call<Block>('POST', `/workspaces/${wsId}/blocks`, {
        type: 'service',
        position: { x: 900, y: 900 },
      })
      const providerId = provider.body.id
      expect(providerId).toBeTruthy()

      const serviceConnections = [
        { serviceBlockId: providerId, description: 'sends transactional email via it' },
      ]
      const patched = await call<Block>('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, {
        serviceConnections,
      })
      expect(patched.status).toBe(200)
      expect(patched.body.serviceConnections).toEqual(serviceConnections)

      // The task may involve a connected neighbor (either direction); its own frame never.
      const task = await call<Block>('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
        involvedServiceIds: [providerId],
      })
      expect(task.status).toBe(200)
      expect(task.body.involvedServiceIds).toEqual([providerId])

      const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      expect(snap.body.blocks.find((b) => b.id === 'blk_auth')?.serviceConnections).toEqual(
        serviceConnections,
      )
      expect(snap.body.blocks.find((b) => b.id === 'task_login')?.involvedServiceIds).toEqual([
        providerId,
      ])

      // Write-gate guards: a self-connection and an unconnected involved service are
      // ValidationErrors (422 per the shared error handler).
      const selfConn = await call('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, {
        serviceConnections: [{ serviceBlockId: 'blk_auth' }],
      })
      expect(selfConn.status).toBe(422)
      const unconnected = await call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
        involvedServiceIds: ['blk_db'],
      })
      expect(unconnected.status).toBe(422)
    })

    it("round-trips a task's read-only reference repos (the JSON column) on every store", async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      // `referenceRepos` is a DOCUMENT-task-only JSON column carrying the doc-writer agent's
      // read-only reference repos, each a self-contained clone identity (NOT resolved from
      // the repo projection). BoardService.update drops it on any non-document block, so the
      // round-trip is asserted on a real document task: a runtime that forgot to map the
      // column drops it on write, so this checks it survives PATCH + a fresh snapshot read,
      // and that clearing writes NULL (an empty array comes back absent), on D1 and Postgres.
      const doc = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'Author the API guide',
        taskType: 'document',
      })
      expect(doc.status).toBe(201)
      const docId = doc.body.id

      const referenceRepos = [
        { repoId: 111, owner: 'acme', name: 'design-system', defaultBranch: 'main' },
        {
          repoId: 222,
          owner: 'acme',
          name: 'api-conventions',
          defaultBranch: 'trunk',
          connectionId: 42,
        },
      ]
      const set = await call<Block>('PATCH', `/workspaces/${wsId}/blocks/${docId}`, {
        referenceRepos,
      })
      expect(set.status).toBe(200)
      expect(set.body.referenceRepos).toEqual(referenceRepos)

      const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      expect(snap.body.blocks.find((b) => b.id === docId)?.referenceRepos).toEqual(referenceRepos)

      // Clearing with an empty array writes NULL, so the field comes back absent (mirroring
      // the other JSON-array block columns' empty-is-null convention).
      const cleared = await call<Block>('PATCH', `/workspaces/${wsId}/blocks/${docId}`, {
        referenceRepos: [],
      })
      expect(cleared.status).toBe(200)
      expect(cleared.body.referenceRepos).toBeUndefined()
    })

    it("round-trips a task's apriori branches (the JSON column) on every store", async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      // `aprioriBranches` is a task-level JSON column carrying the pre-existing branches handed
      // to the run (one optional `working` branch + any `reference` branches). BoardService
      // validates the cross-entry invariants and drops it on non-task blocks; a runtime that
      // forgot to map the column drops it on write, so this checks it survives PATCH + a fresh
      // snapshot read, and that clearing writes NULL (an empty array comes back absent).
      const task = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'Continue the spike branch',
      })
      expect(task.status).toBe(201)
      const taskId = task.body.id

      const aprioriBranches = [
        { name: 'feature/checkout-v2', mode: 'working' as const },
        { name: 'spike/payments', mode: 'reference' as const },
      ]
      const set = await call<Block>('PATCH', `/workspaces/${wsId}/blocks/${taskId}`, {
        aprioriBranches,
      })
      expect(set.status).toBe(200)
      expect(set.body.aprioriBranches).toEqual(aprioriBranches)

      const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      expect(snap.body.blocks.find((b) => b.id === taskId)?.aprioriBranches).toEqual(
        aprioriBranches,
      )

      // Two working entries are rejected at the write boundary (single-working invariant).
      const twoWorking = await call<Block>('PATCH', `/workspaces/${wsId}/blocks/${taskId}`, {
        aprioriBranches: [
          { name: 'a', mode: 'working' },
          { name: 'b', mode: 'working' },
        ],
      })
      expect(twoWorking.status).toBe(422)

      // An unsafe git ref name is rejected by the contract schema (400, not the 422 write
      // boundary) — a value that would break the harness fetch/checkout never persists.
      const unsafe = await call<Block>('PATCH', `/workspaces/${wsId}/blocks/${taskId}`, {
        aprioriBranches: [{ name: 'bad name~with^stuff', mode: 'reference' }],
      })
      expect(unsafe.status).toBe(400)

      // Clearing with an empty array writes NULL, so the field comes back absent.
      const cleared = await call<Block>('PATCH', `/workspaces/${wsId}/blocks/${taskId}`, {
        aprioriBranches: [],
      })
      expect(cleared.status).toBe(200)
      expect(cleared.body.aprioriBranches).toBeUndefined()
    })

    it("records a multi-repo run's peer pull requests on the block (both stores)", async () => {
      // Service-connections phase 3: a coder run over a task with a connected involved service
      // opens a PR in the peer's repo too. The container reports it as `peerPullRequests`
      // beside the own-service PR; the engine records BOTH on the block. This asserts the
      // full recording + JSON-column round-trip on D1 and Postgres (the fake stands in for
      // the container — the resolveRepoTargets/peerRepos dispatch path is unit-tested in the
      // server package). `allPullRequests` then sees the own PR first, then the peer.
      const app = harness.makeApp({
        asyncKinds: ['coder'],
        asyncPolls: 1,
        pullRequest: {
          url: 'https://gh/acme/auth/pull/1',
          number: 1,
          branch: 'cat-factory/task_login',
        },
        peerPullRequests: [
          {
            repo: 'acme/email',
            frameId: 'blk_email',
            ref: {
              url: 'https://gh/acme/email/pull/7',
              number: 7,
              branch: 'cat-factory/task_login',
            },
          },
        ],
      })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      // Connect blk_auth → a provider frame and mark it involved in the task (realistic setup;
      // the recording itself is driven by what the fake reports, not the resolution).
      const provider = await app.call<Block>('POST', `/workspaces/${wsId}/blocks`, {
        type: 'service',
        position: { x: 900, y: 900 },
      })
      await app.call('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, {
        serviceConnections: [
          { serviceBlockId: provider.body.id, description: 'sends mail via it' },
        ],
      })
      await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
        involvedServiceIds: [provider.body.id],
      })

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Implement',
        agentKinds: ['coder'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)
      await app.drive(wsId)

      const snap = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      const task = snap.body.blocks.find((b) => b.id === 'task_login')!
      expect(task.pullRequest?.url).toBe('https://gh/acme/auth/pull/1')
      expect(task.peerPullRequests).toEqual([
        {
          repo: 'acme/email',
          frameId: 'blk_email',
          ref: {
            url: 'https://gh/acme/email/pull/7',
            number: 7,
            branch: 'cat-factory/task_login',
          },
        },
      ])
      expect(allPullRequests(task)).toEqual([
        { ref: task.pullRequest },
        { repo: 'acme/email', frameId: 'blk_email', ref: task.peerPullRequests![0]!.ref },
      ])
    })

    it('rejects a dependency edge that would create a cycle', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id
      const a = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'A',
      })
      const b = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'B',
      })
      // A dependsOn B — fine.
      const first = await call('POST', `/workspaces/${wsId}/blocks/${a.body.id}/dependencies`, {
        sourceId: b.body.id,
      })
      expect(first.status).toBe(200)
      // B dependsOn A — would close a cycle, rejected (ValidationError → 422).
      const cyclic = await call('POST', `/workspaces/${wsId}/blocks/${b.body.id}/dependencies`, {
        sourceId: a.body.id,
      })
      expect(cyclic.status).toBe(422)
    })

    it('refuses to start a task while a dependency is unfinished', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id
      const pipeline = await call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Code only',
        agentKinds: ['coder'],
      })
      const blocker = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'Blocker',
      })
      // task_login dependsOn the (planned) blocker.
      await call('POST', `/workspaces/${wsId}/blocks/task_login/dependencies`, {
        sourceId: blocker.body.id,
      })
      const blocked = await call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(blocked.status).toBe(409)
    })

    it('findByIds resolves blocks across workspaces in one batched read', async () => {
      // The cross-workspace dependency gate resolves a dependent's foreign blockers via
      // the batched `BlockRepository.findByIds` (never a point-read per id) — assert the
      // batched read maps each block to its HOME workspace identically on every store.
      const app = harness.makeApp()
      const { workspace: wsA } = await app.createWorkspace()
      const { workspace: wsB } = await app.createWorkspace()
      const a = await app.call<Block>('POST', `/workspaces/${wsA.id}/blocks/blk_auth/tasks`, {
        title: 'Home task',
      })
      const b = await app.call<Block>('POST', `/workspaces/${wsB.id}/blocks/blk_auth/tasks`, {
        title: 'Foreign task',
      })
      const repo = app.blockRepository()
      const found = await repo.findByIds([a.body.id, b.body.id, 'blk_does_not_exist'])
      // Both blocks resolve with their home workspace; the unknown id is simply absent.
      expect(found).toHaveLength(2)
      const byId = new Map(found.map((f) => [f.block.id, f]))
      expect(byId.get(a.body.id)?.workspaceId).toBe(wsA.id)
      expect(byId.get(b.body.id)?.workspaceId).toBe(wsB.id)
      expect(byId.get(a.body.id)?.block.title).toBe('Home task')
      // Empty input short-circuits to an empty result.
      expect(await repo.findByIds([])).toEqual([])
    })
  })
}

/**
 * The notification inbox and the per-workspace model-preset library.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerNotificationAndPresetTests(harness: ConformanceHarness): void {
  describe('notifications', () => {
    it('escalateStaleOpen flips exactly the overdue open normal cards in one statement', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const repo = app.notificationRepository()
      const card = (id: string, overrides: Partial<Notification>): Notification =>
        ({
          id,
          type: 'merge_review',
          status: 'open',
          severity: 'normal',
          blockId: null,
          executionId: null,
          title: id,
          body: 'body',
          payload: null,
          createdAt: 1_000,
          resolvedAt: null,
          ...overrides,
        }) as Notification
      await repo.upsert(wsId, card('ntf_overdue', {}))
      await repo.upsert(wsId, card('ntf_recent', { createdAt: 50_000 }))
      await repo.upsert(wsId, card('ntf_already_urgent', { severity: 'urgent' }))
      await repo.upsert(wsId, card('ntf_dismissed', { status: 'dismissed', resolvedAt: 2_000 }))

      // Only the open, still-normal card past the cutoff flips — and is returned for
      // re-delivery (the real-time inbox re-render).
      const escalated = await repo.escalateStaleOpen(wsId, 10_000)
      expect(escalated.map((n) => n.id)).toEqual(['ntf_overdue'])
      expect(escalated[0]?.severity).toBe('urgent')

      const open = await repo.listOpen(wsId)
      const severityById = new Map(open.map((n) => [n.id, n.severity]))
      expect(severityById.get('ntf_overdue')).toBe('urgent')
      expect(severityById.get('ntf_recent')).toBe('normal')
      expect(severityById.get('ntf_already_urgent')).toBe('urgent')
      // Idempotent: a second sweep finds nothing left to flip.
      expect(await repo.escalateStaleOpen(wsId, 10_000)).toEqual([])
    })

    it('claimForAction atomically flips open→acted exactly once (act double-fire guard)', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const repo = app.notificationRepository()
      const card: Notification = {
        id: 'ntf_act',
        type: 'merge_review',
        status: 'open',
        severity: 'normal',
        blockId: null,
        executionId: null,
        title: 'merge?',
        body: 'body',
        payload: null,
        createdAt: 1_000,
        resolvedAt: null,
      }
      await repo.upsert(wsId, card)

      // Two concurrent claims race the conditional UPDATE; exactly one wins the flip and
      // gets the row back (its side effect would run), the other is handed null and skips it.
      const [a, b] = await Promise.all([
        repo.claimForAction(wsId, 'ntf_act', 5_000),
        repo.claimForAction(wsId, 'ntf_act', 6_000),
      ])
      const winners = [a, b].filter((n) => n !== null)
      expect(winners).toHaveLength(1)
      expect(winners[0]?.status).toBe('acted')

      // The card is now acted; a later claim (or a re-click) finds it non-open → null.
      const persisted = await repo.get(wsId, 'ntf_act')
      expect(persisted?.status).toBe('acted')
      expect(persisted?.resolvedAt).toBe(winners[0]?.resolvedAt)
      expect(await repo.claimForAction(wsId, 'ntf_act', 7_000)).toBeNull()
    })
  })

  describe('model presets', () => {
    it('seeds the built-ins, CRUDs presets and surfaces them on the snapshot', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()

      // A fresh workspace is lazily seeded with the built-in catalog: Kimi K2.7 (the
      // Cloudflare-runnable default in the conformance harnesses, everything Kimi), GLM-5.2,
      // and Claude Opus 5. Each built-in carries its catalog version.
      const initial = await call<ModelPreset[]>('GET', `/workspaces/${workspace.id}/model-presets`)
      expect(initial.status).toBe(200)
      const seeded = initial.body
      expect(seeded.length).toBeGreaterThanOrEqual(3)
      const def = seeded.find((p) => p.isDefault)
      expect(def?.baseModelId).toBe('kimi-k2.7')
      expect(def?.version).toBe(1)
      expect(seeded.some((p) => p.baseModelId === 'glm')).toBe(true)
      // The Claude-only built-in ships in the catalog (default only in local mode; here it's
      // present but non-default since the conformance harnesses seed with Kimi as the default).
      const claude = seeded.find((p) => p.id === 'mdp_claude')
      expect(claude?.baseModelId).toBe('claude-opus')
      expect(claude?.isDefault).toBe(false)

      // Create a new preset with a per-agent override and promote it to default.
      const created = await call<ModelPreset>('POST', `/workspaces/${workspace.id}/model-presets`, {
        name: 'Mixed',
        baseModelId: 'glm',
        overrides: { architect: 'kimi-k2.7' },
        isDefault: true,
      })
      expect(created.status).toBe(201)
      expect(created.body.isDefault).toBe(true)
      expect(created.body.overrides.architect).toBe('kimi-k2.7')

      // Promoting it demoted the previous default (single-default invariant).
      const afterCreate = await call<ModelPreset[]>(
        'GET',
        `/workspaces/${workspace.id}/model-presets`,
      )
      expect(afterCreate.body.filter((p) => p.isDefault)).toHaveLength(1)
      expect(afterCreate.body.find((p) => p.isDefault)?.id).toBe(created.body.id)

      // Patch the base model.
      const patched = await call<ModelPreset>(
        'PATCH',
        `/workspaces/${workspace.id}/model-presets/${created.body.id}`,
        { baseModelId: 'kimi-k2.7' },
      )
      expect(patched.status).toBe(200)
      expect(patched.body.baseModelId).toBe('kimi-k2.7')

      // The library rides along on the workspace snapshot.
      const snapshot = await call<WorkspaceSnapshot>('GET', `/workspaces/${workspace.id}`)
      expect((snapshot.body.modelPresets ?? []).some((p) => p.name === 'Mixed')).toBe(true)
    })

    it('ships catalog versions on the snapshot and reseeds a built-in (drift repair + new appeared)', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id
      const base = `/workspaces/${wsId}/model-presets`

      // The snapshot ships the built-in catalog versions so the SPA can offer a reseed.
      const snap = await call<{ modelPresetCatalogVersions?: Record<string, number> }>(
        'GET',
        `/workspaces/${wsId}`,
      )
      expect(snap.body.modelPresetCatalogVersions).toMatchObject({
        mdp_kimi: 1,
        mdp_glm: 1,
        mdp_claude: 2,
      })

      // Seed, then drift a built-in (rename + change its base model). Reseed must restore the
      // canonical definition + version while preserving the user's default + ordering.
      await call('GET', base)
      await call('PATCH', `${base}/mdp_kimi`, { name: 'Tampered', baseModelId: 'glm' })
      const reseeded = await call<ModelPreset>('POST', `${base}/mdp_kimi/reseed`)
      expect(reseeded.status).toBe(200)
      expect(reseeded.body.name).toBe('Kimi K2.7')
      expect(reseeded.body.baseModelId).toBe('kimi-k2.7')
      expect(reseeded.body.version).toBe(1)
      // The default is preserved across a reseed (the conformance harnesses default to Kimi).
      expect(reseeded.body.isDefault).toBe(true)

      // Reseeding a NEW built-in the workspace doesn't have yet materialises it (the
      // "appeared upstream" case): delete the claude preset, then reseed it back.
      await call('DELETE', `${base}/mdp_claude`)
      const afterDelete = await call<ModelPreset[]>('GET', base)
      expect(afterDelete.body.some((p) => p.id === 'mdp_claude')).toBe(false)
      const readded = await call<ModelPreset>('POST', `${base}/mdp_claude/reseed`)
      expect(readded.status).toBe(200)
      expect(readded.body.baseModelId).toBe('claude-opus')
      // Re-materialising a non-default built-in must not steal the default from Kimi.
      expect(readded.body.isDefault).toBe(false)

      // A custom (non-catalog) preset cannot be reseeded — delete it instead.
      const custom = await call<ModelPreset>('POST', base, { name: 'Custom', baseModelId: 'glm' })
      const badReseed = await call('POST', `${base}/${custom.body.id}/reseed`)
      expect(badReseed.status).toBe(422)
    })
  })
}
