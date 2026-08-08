import {
  type Block,
  type Pipeline,
  type PipelineSchedule,
  type WorkspaceSnapshot,
  PipelineRegistry,
  seedPipelines,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'
import { definePrReviewSuite } from './execution-pr-review.js'

// Core conformance, slice 3: the planning surfaces — the public initiative-breakdown API,
// pipeline versioning + reseed, service spec reads, task types + the per-service running-task
// limit, and the PR deep-review park/select/resolve flow. Split out of the former monolithic
// `core.ts`; re-opens its `describe` groups inside the aggregator's `[name] conformance` wrapper
// (test tree unchanged).
export function defineCorePlanningConformance(harness: ConformanceHarness): void {
  describe('public API (break down an initiative)', () => {
    registerPublicApiTests(harness)
    registerPublicApiScopeTests(harness)
  })
  registerPipelineCatalogTests(harness)

  describe('service spec read', () => {
    it('serves an empty service-spec view when GitHub is not wired', async () => {
      // The "View Requirements" window reads the sharded `spec/` artifact off the repo
      // default branch via the shared controller, resolved through the same
      // `resolveRunRepoContext` seam on both facades. With no GitHub wired (the
      // conformance harness), the route must be mounted and return an empty (present:false)
      // view identically — proving the symmetric wiring rather than one facade 404-ing.
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const res = await call<{ present: boolean; spec: unknown; features: unknown[] }>(
        'GET',
        `/workspaces/${workspace.id}/blocks/blk_auth/spec`,
      )
      expect(res.status).toBe(200)
      expect(res.body.present).toBe(false)
      expect(res.body.spec).toBeNull()
      expect(res.body.features).toEqual([])
    })

    it('serves an empty view for a run whose spec cannot be read, rather than 404-ing', async () => {
      // The RUN-scoped sibling, which the outcome card joins its requirement verdicts against.
      // It reads the branch the run pushed to (the service read above reads the repo default),
      // through the engine's own evidence loader, so it must be mounted and answer identically
      // on both facades. A run this workspace does not have is the same answer as one whose
      // spec could not be read: the card states either as `spec: 'not_read'`, and a 404 would
      // make it an error on a run it is already rendering.
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const res = await call<{ present: boolean; spec: unknown; features: unknown[] }>(
        'GET',
        `/workspaces/${workspace.id}/executions/exec_nope/spec`,
      )
      expect(res.status).toBe(200)
      expect(res.body.present).toBe(false)
      expect(res.body.spec).toBeNull()
      expect(res.body.features).toEqual([])
    })
  })

  registerBoardPlanningTests(harness)

  // PR deep-review park → select → resolve — extracted to keep this function within its
  // line budget (see CLAUDE.md: split, never raise the budget).
  definePrReviewSuite(harness)
}

/**
 * The headless `/api/v1` surface: key authentication, the task lifecycle, and the bounded
 * keyset-paginated job + service-task lists.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerPublicApiTests(harness: ConformanceHarness): void {
  it('authenticates a public-API key, runs a public inline pipeline headlessly, persists a retrievable result, and hides the anchor block', async () => {
    const { call, createOrgWorkspace, drive } = harness.makeApp()
    // Account-scoped: public-API keys are only minted for an account-owning workspace, so use a
    // seeded ORG workspace (the seed brings the built-in `pl_initiative_breakdown` pipeline).
    const { workspace } = await createOrgWorkspace({ seed: true })
    const wsId = workspace.id

    // Mint an inbound public-API key (needs ENCRYPTION_KEY, which both harnesses configure).
    const created = await call<{ key: { id: string }; secret: string }>(
      'POST',
      `/workspaces/${wsId}/public-api-keys`,
      { label: 'external' },
    )
    expect(created.status).toBe(201)
    const secret = created.body.secret
    expect(secret).toMatch(/^cf_live_/)
    const auth = { authorization: `Bearer ${secret}` }

    // A missing key is refused; a valid key starts the run.
    expect(
      (
        await call('POST', '/api/v1/jobs', {
          pipelineId: 'pl_initiative_breakdown',
          input: 'x',
        })
      ).status,
    ).toBe(401)
    const started = await call<{ jobId: string; status: string }>(
      'POST',
      '/api/v1/jobs',
      { pipelineId: 'pl_initiative_breakdown', input: 'Build a cat feeder service' },
      auth,
    )
    expect(started.status).toBe(202)
    const jobId = started.body.jobId

    // Drive the run to completion and read back the DB-persisted result.
    await drive(wsId)
    const job = await call<{ status: string; result: { output: string } | null }>(
      'GET',
      `/api/v1/jobs/${jobId}`,
      undefined,
      auth,
    )
    expect(job.status).toBe(200)
    expect(job.body.status).toBe('succeeded')
    expect(job.body.result?.output).toBeTruthy()

    // The headless anchor block AND its execution are excluded from the board snapshot on both
    // stores — neither the hidden block nor the external run's brief/output reaches the SPA.
    const board = await call<{
      blocks: { title: string; internal?: boolean }[]
      executions: { id: string }[]
    }>('GET', `/workspaces/${wsId}`)
    expect(board.body.blocks.some((b) => b.internal)).toBe(false)
    expect(board.body.blocks.some((b) => b.title === 'Build a cat feeder service')).toBe(false)
    expect(board.body.executions.some((e) => e.id === jobId)).toBe(false)

    // A key can read ONLY the initiative runs it created, never an arbitrary board run in the
    // same workspace: start the SAME public pipeline on a NORMAL seeded task, and the key gets
    // a 404 (its anchor block isn't internal), even though the run exists and shares the scope.
    const normalStart = await call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
      pipelineId: 'pl_initiative_breakdown',
    })
    expect(normalStart.status).toBe(201)
    const normalExec = (await drive(wsId)).find((e) => e.blockId === 'task_login')!
    expect((await call('GET', `/api/v1/jobs/${normalExec.id}`, undefined, auth)).status).toBe(404)

    // Concurrency backstop (both stores): a workspace may only have 5 initiative runs in
    // flight; leaving them undriven, the 6th start is refused with 429.
    for (let i = 0; i < 5; i++) {
      expect(
        (
          await call(
            'POST',
            '/api/v1/jobs',
            { pipelineId: 'pl_initiative_breakdown', input: `run ${i}` },
            auth,
          )
        ).status,
      ).toBe(202)
    }
    expect(
      (
        await call(
          'POST',
          '/api/v1/jobs',
          { pipelineId: 'pl_initiative_breakdown', input: 'overflow' },
          auth,
        )
      ).status,
    ).toBe(429)
    await drive(wsId) // let the in-flight runs finish so none dangle

    // A non-public pipeline id is refused; a revoked key no longer authenticates.
    expect(
      (await call('POST', '/api/v1/jobs', { pipelineId: 'pl_blueprint', input: 'x' }, auth)).status,
    ).toBe(400)
    expect(
      (await call('DELETE', `/workspaces/${wsId}/public-api-keys/${created.body.key.id}`)).status,
    ).toBe(204)
    expect((await call('GET', `/api/v1/jobs/${jobId}`, undefined, auth)).status).toBe(401)
  })

  it('serves the full task lifecycle (edit / stop / retry / rich run) + pipeline discovery, workspace-scoped', async () => {
    const { call, createOrgWorkspace, drive } = harness.makeApp()
    const { workspace } = await createOrgWorkspace({ seed: true })
    const wsId = workspace.id

    const created = await call<{ secret: string }>('POST', `/workspaces/${wsId}/public-api-keys`, {
      label: 'external',
    })
    expect(created.status).toBe(201)
    const auth = { authorization: `Bearer ${created.body.secret}` }

    // Pipeline discovery: the public inline pipeline is public + headless-startable; a
    // container pipeline (pl_simple) is listed but neither. Closes the "start demands a
    // pipelineId, nothing lists them" gap.
    const pipelines = await call<{
      pipelines: {
        pipelineId: string
        steps: string[]
        public: boolean
        headlessStartable: boolean
      }[]
    }>('GET', '/api/v1/pipelines', undefined, auth)
    expect(pipelines.status).toBe(200)
    const byId = new Map(pipelines.body.pipelines.map((p) => [p.pipelineId, p]))
    const breakdown = byId.get('pl_initiative_breakdown')
    expect(breakdown?.public).toBe(true)
    expect(breakdown?.headlessStartable).toBe(true)
    expect(breakdown && breakdown.steps.length > 0).toBe(true)
    const quick = byId.get('pl_simple')
    expect(quick).toBeTruthy()
    expect(quick?.headlessStartable).toBe(false)

    // Create a task under a fresh service frame (via the dev-open session board route).
    const frame = await call<{ id: string }>('POST', `/workspaces/${wsId}/blocks`, {
      type: 'service',
      position: { x: 500, y: 500 },
    })
    const task = await call<{ taskId: string }>(
      'POST',
      `/api/v1/services/${frame.body.id}/tasks`,
      { title: 'Lifecycle task', description: 'original' },
      auth,
    )
    expect(task.status).toBe(201)
    const taskId = task.body.taskId

    // Edit (PATCH) the title/description before it runs.
    const edited = await call<{ title: string; description: string }>(
      'PATCH',
      `/api/v1/tasks/${taskId}`,
      { title: 'Lifecycle task (edited)', description: 'reworded' },
      auth,
    )
    expect(edited.status).toBe(200)
    expect(edited.body.title).toBe('Lifecycle task (edited)')
    expect(edited.body.description).toBe('reworded')

    // A not-yet-started task has no run to read or stop.
    expect((await call('GET', `/api/v1/tasks/${taskId}/run`, undefined, auth)).status).toBe(404)
    expect((await call('POST', `/api/v1/tasks/${taskId}/stop`, undefined, auth)).status).toBe(409)

    // Start it (async — left running until driven), then read the rich run projection.
    const started = await call<{ runId: string | null }>(
      'POST',
      `/api/v1/tasks/${taskId}/start`,
      { pipelineId: 'pl_simple' },
      auth,
    )
    expect(started.status).toBe(202)
    const run = await call<{
      runId: string
      taskId: string
      status: string
      steps: { agentKind: string; state: string; progress: number }[]
    }>('GET', `/api/v1/tasks/${taskId}/run`, undefined, auth)
    expect(run.status).toBe(200)
    expect(run.body.taskId).toBe(taskId)
    expect(run.body.steps.length).toBeGreaterThan(0)
    expect(['running', 'blocked', 'paused', 'done']).toContain(run.body.status)

    // Stop the run → it settles `failed` with a `cancelled` error, and stays retryable.
    expect((await call('POST', `/api/v1/tasks/${taskId}/stop`, undefined, auth)).status).toBe(200)
    const stopped = await call<{ status: string; error: { code: string } | null }>(
      'GET',
      `/api/v1/tasks/${taskId}/run`,
      undefined,
      auth,
    )
    expect(stopped.body.status).toBe('failed')
    expect(stopped.body.error?.code).toBe('cancelled')

    // Retry the failed run, then drive it to completion.
    expect((await call('POST', `/api/v1/tasks/${taskId}/retry`, undefined, auth)).status).toBe(202)
    await drive(wsId)
    const finished = await call<{ status: string }>(
      'GET',
      `/api/v1/tasks/${taskId}/run`,
      undefined,
      auth,
    )
    expect(finished.body.status).toBe('done')

    // Every lifecycle route double-scopes to the key's workspace: a key from ANOTHER
    // workspace 404s on this task (never edits/stops/retries/reads it).
    const other = await createOrgWorkspace({ seed: true })
    const otherKey = await call<{ secret: string }>(
      'POST',
      `/workspaces/${other.workspace.id}/public-api-keys`,
      { label: 'other' },
    )
    const otherAuth = { authorization: `Bearer ${otherKey.body.secret}` }
    expect((await call('GET', `/api/v1/tasks/${taskId}/run`, undefined, otherAuth)).status).toBe(
      404,
    )
    expect((await call('PATCH', `/api/v1/tasks/${taskId}`, { title: 'x' }, otherAuth)).status).toBe(
      404,
    )
    expect((await call('POST', `/api/v1/tasks/${taskId}/stop`, undefined, otherAuth)).status).toBe(
      404,
    )
    expect((await call('POST', `/api/v1/tasks/${taskId}/retry`, undefined, otherAuth)).status).toBe(
      404,
    )
  })

  // Tier 2 of the public-API initiative: the two list reads that used to be unbounded (the
  // service-task list read the WHOLE board and filtered in JS) or absent entirely (the job
  // list). Both now push their bound, subtree, filters and ordering into SQL through new
  // repository ports, so these assert the D1 and Drizzle implementations page identically — a
  // store that ordered differently, dropped the `internal` join, or mishandled the keyset fails
  // here rather than silently mis-serving an external integration. Split in two (one per list)
  // to stay within the per-function statement budget.
  registerPublicApiListTests(harness)
}

/**
 * The public API's scope ladder (read ⊂ write ⊂ decide ⊂ admin), the notification inbox
 * it serves, and the workspace usage + budget read.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerPublicApiScopeTests(harness: ConformanceHarness): void {
  it('gates each route on the key scope ladder (read ⊂ write ⊂ admin) and deletes with admin', async () => {
    const { call, createOrgWorkspace } = harness.makeApp()
    const { workspace } = await createOrgWorkspace({ seed: true })
    const wsId = workspace.id

    // Mint one key per scope. An omitted scope defaults to `write`.
    const mint = async (scope: 'read' | 'write' | 'admin') => {
      const res = await call<{ key: { scope: string }; secret: string }>(
        'POST',
        `/workspaces/${wsId}/public-api-keys`,
        { label: scope, scope },
      )
      expect(res.status).toBe(201)
      expect(res.body.key.scope).toBe(scope)
      return { authorization: `Bearer ${res.body.secret}` }
    }
    const readAuth = await mint('read')
    const writeAuth = await mint('write')
    const adminAuth = await mint('admin')
    // The default (no scope in the body) is `write`.
    const defaulted = await call<{ key: { scope: string } }>(
      'POST',
      `/workspaces/${wsId}/public-api-keys`,
      { label: 'defaulted' },
    )
    expect(defaulted.body.key.scope).toBe('write')

    const frame = await call<{ id: string }>('POST', `/workspaces/${wsId}/blocks`, {
      type: 'service',
      position: { x: 400, y: 400 },
    })
    const serviceId = frame.body.id

    // A `read` key can read (list services) but is refused (403 insufficient_scope) on any
    // write — e.g. creating a task.
    expect((await call('GET', '/api/v1/services', undefined, readAuth)).status).toBe(200)
    const readCreate = await call<{ error: { code: string } }>(
      'POST',
      `/api/v1/services/${serviceId}/tasks`,
      { title: 'nope', description: 'x' },
      readAuth,
    )
    expect(readCreate.status).toBe(403)
    expect(readCreate.body.error.code).toBe('insufficient_scope')

    // A `write` key creates the task (and can read it) but is refused on the destructive DELETE.
    const created = await call<{ taskId: string }>(
      'POST',
      `/api/v1/services/${serviceId}/tasks`,
      { title: 'Scoped task', description: 'x' },
      writeAuth,
    )
    expect(created.status).toBe(201)
    const taskId = created.body.taskId
    expect((await call('GET', `/api/v1/tasks/${taskId}`, undefined, readAuth)).status).toBe(200)
    const writeDelete = await call<{ error: { code: string } }>(
      'DELETE',
      `/api/v1/tasks/${taskId}`,
      undefined,
      writeAuth,
    )
    expect(writeDelete.status).toBe(403)
    expect(writeDelete.body.error.code).toBe('insufficient_scope')
    // Still present after the refused delete.
    expect((await call('GET', `/api/v1/tasks/${taskId}`, undefined, readAuth)).status).toBe(200)

    // An `admin` key deletes it; the task is then gone (404) for every scope.
    expect((await call('DELETE', `/api/v1/tasks/${taskId}`, undefined, adminAuth)).status).toBe(204)
    expect((await call('GET', `/api/v1/tasks/${taskId}`, undefined, readAuth)).status).toBe(404)
    // Deleting an already-gone task is idempotent-but-scoped: a real task no longer resolves,
    // so it 404s (never a 5xx) even for admin.
    expect((await call('DELETE', `/api/v1/tasks/${taskId}`, undefined, adminAuth)).status).toBe(404)
  })

  it('serves the notification inbox (list / dismiss / act), scope-gated + workspace-scoped', async () => {
    const app = harness.makeApp()
    const { call, createOrgWorkspace } = app
    const { workspace } = await createOrgWorkspace({ seed: true })
    const wsId = workspace.id

    const mint = async (scope: 'read' | 'write' | 'admin') => {
      const res = await call<{ secret: string }>('POST', `/workspaces/${wsId}/public-api-keys`, {
        label: scope,
        scope,
      })
      expect(res.status).toBe(201)
      return { authorization: `Bearer ${res.body.secret}` }
    }
    const readAuth = await mint('read')
    const writeAuth = await mint('write')
    const adminAuth = await mint('admin')

    // Seed OPEN notifications directly (the engine raises these mid-run; seeding the
    // persisted rows keeps the test targeted at the public routes, not the run machinery).
    // The actionable cards are `merge_review` with a null `blockId`: `act` admits the type
    // (it has an automated merge side-effect) but the null block short-circuits the merge, so
    // the card settles `acted` without needing a real block/run/PR.
    const seed = (id: string, type: 'merge_review' | 'requirement_review' = 'merge_review') =>
      app.notificationRepository().upsert(wsId, {
        id,
        type,
        status: 'open',
        severity: 'normal',
        blockId: null,
        executionId: null,
        title: id,
        body: 'body',
        payload: null,
        createdAt: 1,
        resolvedAt: null,
      })
    await seed('ntf_dismiss')
    await seed('ntf_act')

    // An informational card (`requirement_review`) — it parks a run on an interactive human
    // decision, so it has NO automated action and `act` must refuse it (→ dismiss instead).
    await seed('ntf_info', 'requirement_review')

    // list: a `read` key sees all three open cards.
    const listed = await call<{ notifications: { id: string; status: string }[] }>(
      'GET',
      '/api/v1/notifications',
      undefined,
      readAuth,
    )
    expect(listed.status).toBe(200)
    expect(new Set(listed.body.notifications.map((n) => n.id))).toEqual(
      new Set(['ntf_dismiss', 'ntf_act', 'ntf_info']),
    )

    // Scope ladder: a `read` key can't dismiss/act; a `write` key can dismiss but not act
    // (act performs a real merge → admin only).
    const readDismiss = await call<{ error: { code: string } }>(
      'POST',
      '/api/v1/notifications/ntf_dismiss/dismiss',
      undefined,
      readAuth,
    )
    expect(readDismiss.status).toBe(403)
    expect(readDismiss.body.error.code).toBe('insufficient_scope')
    const writeAct = await call<{ error: { code: string } }>(
      'POST',
      '/api/v1/notifications/ntf_act/act',
      undefined,
      writeAuth,
    )
    expect(writeAct.status).toBe(403)
    expect(writeAct.body.error.code).toBe('insufficient_scope')

    // dismiss (write) resolves the card as `dismissed`; act (admin) resolves it as `acted`.
    const dismissed = await call<{ status: string }>(
      'POST',
      '/api/v1/notifications/ntf_dismiss/dismiss',
      undefined,
      writeAuth,
    )
    expect(dismissed.status).toBe(200)
    expect(dismissed.body.status).toBe('dismissed')
    const acted = await call<{ status: string }>(
      'POST',
      '/api/v1/notifications/ntf_act/act',
      undefined,
      adminAuth,
    )
    expect(acted.status).toBe(200)
    expect(acted.body.status).toBe('acted')

    // `act` refuses an informational card (no automated action) with 409, even for an admin
    // key — it must be dismissed, not acted — while `dismiss` resolves it normally.
    const actInfo = await call<{ error: { code: string } }>(
      'POST',
      '/api/v1/notifications/ntf_info/act',
      undefined,
      adminAuth,
    )
    expect(actInfo.status).toBe(409)
    expect(actInfo.body.error.code).toBe('notification_not_actionable')
    const dismissInfo = await call<{ status: string }>(
      'POST',
      '/api/v1/notifications/ntf_info/dismiss',
      undefined,
      writeAuth,
    )
    expect(dismissInfo.status).toBe(200)
    expect(dismissInfo.body.status).toBe('dismissed')

    // All resolved, so the inbox is now empty (list is open-only).
    const after = await call<{ notifications: unknown[] }>(
      'GET',
      '/api/v1/notifications',
      undefined,
      readAuth,
    )
    expect(after.body.notifications).toEqual([])

    // Workspace-scoped: a key from ANOTHER workspace never sees or resolves this
    // workspace's notifications (an unknown/foreign id is a 404 on both act and dismiss).
    await seed('ntf_foreign')
    const other = await createOrgWorkspace({ seed: true })
    const otherKey = await call<{ secret: string }>(
      'POST',
      `/workspaces/${other.workspace.id}/public-api-keys`,
      { label: 'admin', scope: 'admin' },
    )
    const otherAuth = { authorization: `Bearer ${otherKey.body.secret}` }
    const otherList = await call<{ notifications: unknown[] }>(
      'GET',
      '/api/v1/notifications',
      undefined,
      otherAuth,
    )
    expect(otherList.body.notifications).toEqual([])
    expect(
      (await call('POST', '/api/v1/notifications/ntf_foreign/act', undefined, otherAuth)).status,
    ).toBe(404)
    expect(
      (await call('POST', '/api/v1/notifications/ntf_foreign/dismiss', undefined, otherAuth))
        .status,
    ).toBe(404)
  })

  it('serves the workspace usage + budget read to a read-scoped key', async () => {
    const { call, createOrgWorkspace } = harness.makeApp()
    const { workspace } = await createOrgWorkspace({ seed: true })
    const wsId = workspace.id

    const minted = await call<{ secret: string }>('POST', `/workspaces/${wsId}/public-api-keys`, {
      label: 'usage',
      scope: 'read',
    })
    const auth = { authorization: `Bearer ${minted.body.secret}` }

    const usage = await call<{
      periodStart: number
      currency: string
      budget: {
        inputTokens: number
        outputTokens: number
        costSpent: number
        costLimit: number
        exceeded: boolean
      }
      rows: { billing: string; model: string; calls: number }[]
    }>('GET', '/api/v1/usage', undefined, auth)
    expect(usage.status).toBe(200)
    // The period is the current calendar month (UTC) and the currency is the deployment's,
    // both resolved by the facade's own pricing wiring — what conformance proves is that BOTH
    // facades serve the same resolved shape, not a particular number.
    expect(usage.body.currency).toBeTruthy()
    expect(usage.body.periodStart).toBeGreaterThan(0)
    // A workspace that has spent nothing this period reports a real zero against a real
    // configured limit, and is NOT paused. `rows` is empty for the same reason — there is no
    // usage to group, which is distinct from a sink the deployment doesn't retain.
    expect(usage.body.budget.inputTokens).toBe(0)
    expect(usage.body.budget.outputTokens).toBe(0)
    expect(usage.body.budget.costSpent).toBe(0)
    expect(usage.body.budget.costLimit).toBeGreaterThan(0)
    expect(usage.body.budget.exceeded).toBe(false)
    expect(usage.body.rows).toEqual([])

    // Read is the whole scope story — the aggregate names no resource ids — but a key is
    // still required, and an unauthenticated caller learns nothing.
    expect((await call('GET', '/api/v1/usage')).status).toBe(401)
  })
}

/**
 * The built-in pipeline catalog's lifecycle: versioned reseed, retire-and-replace, and the
 * two refusals (a built-in the catalog still ships, one a recurring schedule points at).
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerPipelineCatalogTests(harness: ConformanceHarness): void {
  describe('pipeline versioning + reseed', () => {
    it('ships catalog versions on the snapshot and reseeds a built-in, preserving organization', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      // The snapshot advertises the current built-in catalog versions, keyed by id, so the
      // SPA can flag a stale persisted copy and offer a reseed.
      const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      const expectedVersions = Object.fromEntries(
        seedPipelines().map((p) => [p.id, p.version ?? 0]),
      )
      expect(snap.body.pipelineCatalogVersions).toEqual(expectedVersions)
      // A seeded built-in carries its version, persisted + round-tripped through the store.
      const seededFull = snap.body.pipelines.find((p) => p.id === 'pl_full')!
      expect(seededFull.version).toBe(expectedVersions.pl_full)

      // Organize a built-in (label + archive) — user-owned metadata reseed must preserve.
      await call('PATCH', `/workspaces/${wsId}/pipelines/pl_full/organize`, {
        labels: ['mine'],
        archived: true,
      })

      // Reseed restores the canonical definition + version while keeping labels/archive.
      const seed = seedPipelines().find((p) => p.id === 'pl_full')!
      const reseeded = await call<Pipeline>('POST', `/workspaces/${wsId}/pipelines/pl_full/reseed`)
      expect(reseeded.status).toBe(200)
      expect(reseeded.body.agentKinds).toEqual(seed.agentKinds)
      expect(reseeded.body.version).toBe(seed.version)
      expect(reseeded.body.builtin).toBe(true)
      expect(reseeded.body.labels).toEqual(['mine'])
      expect(reseeded.body.archived).toBe(true)

      // It round-trips identically through the store on a fresh read (D1 ⇄ Postgres).
      const after = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      const stored = after.body.pipelines.find((p) => p.id === 'pl_full')!
      expect(stored.labels).toEqual(['mine'])
      expect(stored.archived).toBe(true)
      expect(stored.version).toBe(seed.version)
    })

    it('refuses to reseed a custom pipeline (delete it instead)', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id
      const custom = await call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Custom',
        agentKinds: ['coder'],
      })
      const res = await call('POST', `/workspaces/${wsId}/pipelines/${custom.body.id}/reseed`)
      expect(res.status).toBe(422)
    })

    it('retires a pipeline: advertised on the snapshot, deletable, no longer reseedable', async () => {
      // The lifecycle a real deployment goes through, driven as two apps over ONE store: the board
      // is seeded while the pipeline is still in the catalog, then the deployment ships a version
      // that has withdrawn it. That sequencing is the whole feature — a board created after the
      // withdrawal never holds the row, so the only workspace that needs cleaning is one seeded
      // before it.
      const live = new PipelineRegistry()
      live.register({
        id: 'pl_org_flow',
        name: 'Org flow',
        agentKinds: ['coder', 'reviewer'],
        builtin: true,
        version: 1,
      })
      const before = harness.makeApp(undefined, { pipelineRegistry: live })
      const { workspace } = await before.createWorkspace()
      const wsId = workspace.id
      const seeded = await before.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      expect(seeded.body.pipelines.map((p) => p.id)).toContain('pl_org_flow')
      expect(seeded.body.pipelineCatalogVersions?.pl_org_flow).toBe(1)
      // Scoped to THIS pipeline's id, never asserted as the whole list: the built-in catalog
      // carries its own tombstones (the build-ladder collapse retired six presets), and this test
      // is about a DEPLOYMENT's own retirement. Asserting emptiness here would couple every future
      // built-in retirement to a test that has nothing to do with it.
      expect((seeded.body.retiredPipelines ?? []).map((p) => p.id)).not.toContain('pl_org_flow')

      // The upgraded deployment withdraws it in favour of a live built-in.
      const withdrawn = new PipelineRegistry()
      withdrawn.retire('pl_org_flow', { replacedBy: 'pl_simple' })
      const after = harness.makeApp(undefined, { pipelineRegistry: withdrawn })

      const snap = await after.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      // The row is still stored (nothing deletes it behind the user's back) but is now advertised
      // as retired, and — the property the SPA's "new pipelines" advisory depends on — it is GONE
      // from the catalog versions, so the two channels can never both claim it.
      expect(snap.body.pipelines.map((p) => p.id)).toContain('pl_org_flow')
      expect(snap.body.retiredPipelines).toContainEqual({
        id: 'pl_org_flow',
        replacedBy: 'pl_simple',
      })
      expect(snap.body.pipelineCatalogVersions).not.toHaveProperty('pl_org_flow')

      // Reseed has nothing left to restore from; removal is the action that applies.
      expect(
        (await after.call('POST', `/workspaces/${wsId}/pipelines/pl_org_flow/reseed`)).status,
      ).toBe(422)
      const removed = await after.call('DELETE', `/workspaces/${wsId}/pipelines/pl_org_flow`)
      expect(removed.status).toBe(204)

      // Gone from the store on a fresh read (D1 ⇄ Postgres), and the advisory has nothing left to
      // report — a retirement the board no longer holds a row for is not an outstanding issue.
      const done = await after.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      expect(done.body.pipelines.map((p) => p.id)).not.toContain('pl_org_flow')
    })

    it('refuses to delete a built-in the catalog still ships', async () => {
      // Retirement is the deletion's authorization, so the read-only guarantee on the curated
      // palette is untouched — otherwise this would be a way to empty it one built-in at a time.
      const registry = new PipelineRegistry()
      registry.retire('pl_org_flow')
      const { call, createWorkspace } = harness.makeApp(undefined, { pipelineRegistry: registry })
      const { workspace } = await createWorkspace()
      const res = await call('DELETE', `/workspaces/${workspace.id}/pipelines/pl_full`)
      expect(res.status).toBe(422)
      const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${workspace.id}`)
      expect(snap.body.pipelines.map((p) => p.id)).toContain('pl_full')
    })

    it('refuses to delete a pipeline a recurring schedule still points at', async () => {
      // A deleted pipeline breaks every future fire of its schedule, and a recurring failure is
      // invisible: nobody gets an error, the work just stops happening. The refusal names the fix.
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Nightly custom',
        agentKinds: ['coder', 'reviewer'],
      })
      const schedule = await app.call<PipelineSchedule>(
        'POST',
        `/workspaces/${wsId}/recurring-pipelines`,
        {
          frameId: 'blk_auth',
          pipelineId: pipeline.body.id,
          name: 'Nightly',
          recurrence: {
            intervalHours: 24,
            weekdays: [] as number[],
            windowStartHour: null,
            windowEndHour: null,
            timezone: 'UTC',
          },
        },
      )
      expect(schedule.status).toBe(201)

      const blocked = await app.call('DELETE', `/workspaces/${wsId}/pipelines/${pipeline.body.id}`)
      expect(blocked.status).toBe(409)

      // Detaching the schedule releases it.
      await app.call('DELETE', `/workspaces/${wsId}/recurring-pipelines/${schedule.body.id}`)
      const freed = await app.call('DELETE', `/workspaces/${wsId}/pipelines/${pipeline.body.id}`)
      expect(freed.status).toBe(204)
    })

    it('round-trips the per-step companion toggles (followUps + testerQuality) + stepOptions on every store', async () => {
      // The pipeline builder's two per-step companion toggles live on their own JSON columns
      // (D1/Drizzle `follow_ups` + `tester_quality`), so a custom pipeline that opts a Coder
      // step OUT of the Follow-up companion and configures a Tester step's QC companion (an
      // estimate gate) must survive the store round-trip identically — otherwise the builder
      // toggle silently reverts to the default on the next load. The newer extensible
      // per-step options bag (`step_options` — home of the requirements-review `autoRecommend`
      // toggle) rides the SAME symmetric-persistence contract and is asserted alongside them.
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      const created = await call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Toggles',
        // The prose description rides the same symmetric-persistence contract (its own
        // `description` column on both stores) and must round-trip identically.
        description: 'A custom pipeline for the toggles test.',
        // The Deployer / Disposer pair rides along because the Tester needs the environment
        // lifecycle spelled out (`validatePipelineAuthoring`); every parallel array below is
        // index-aligned with THIS list, so the QC config sits on the Tester at index 3.
        agentKinds: ['task-estimator', 'coder', 'deployer', 'tester-api', 'disposer'],
        // Coder opts out of the Follow-up companion; the Tester's QC companion is gated on the
        // task estimate (an estimator runs earlier, so the gate is valid).
        followUps: [null, false, null, null, null],
        testerQuality: [
          null,
          null,
          null,
          { enabled: true, gating: { enabled: true, minRisk: 0.6, onMissingEstimate: 'run' } },
          null,
        ],
        // A per-step options bag opting one step out of auto-recommendation — the extensible
        // seam that must round-trip through the single `step_options` column on both stores.
        stepOptions: [null, { autoRecommend: false }, null, null, null],
      })
      expect(created.status).toBe(201)
      expect(created.body.description).toBe('A custom pipeline for the toggles test.')
      expect(created.body.followUps?.[1]).toBe(false)
      expect(created.body.testerQuality?.[3]).toEqual({
        enabled: true,
        gating: { enabled: true, minRisk: 0.6, onMissingEstimate: 'run' },
      })
      expect(created.body.stepOptions?.[1]).toEqual({ autoRecommend: false })

      // A fresh snapshot read re-hydrates every column from the store, identically on D1 ⇄ Postgres.
      const snapshot = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      const stored = snapshot.body.pipelines.find((p) => p.id === created.body.id)!
      expect(stored.description).toBe('A custom pipeline for the toggles test.')
      expect(stored.followUps?.[1]).toBe(false)
      expect(stored.testerQuality?.[3]).toEqual({
        enabled: true,
        gating: { enabled: true, minRisk: 0.6, onMissingEstimate: 'run' },
      })
      expect(stored.stepOptions?.[1]).toEqual({ autoRecommend: false })
    })

    it('round-trips a step GATE CONFIG (approver policy + quorum + gate parameters) on every store', async () => {
      // Per-step gate config rides `step_options` too, so it needs no column of its own — but
      // the round-trip is asserted here rather than assumed, because it is the one per-step
      // field whose loss is SILENT AND UNSAFE: an approver policy that does not come back
      // reads to the engine as "anyone may approve", which is exactly the checkpoint the
      // pipeline author added the policy to prevent. Both halves are covered: the
      // platform-enforced approvals, and the parameters the `ci` gate itself declares.
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      const gateConfig = {
        approvers: { roles: ['admin' as const], userIds: ['usr_release_captain'] },
        minApprovals: 2,
      }
      const created = await call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Gated',
        agentKinds: ['coder', 'ci', 'merger'],
        gates: [true, false, false],
        stepOptions: [{ gateConfig }, { gateConfig: { fields: { maxAttempts: 3 } } }, null],
      })
      expect(created.status).toBe(201)
      expect(created.body.stepOptions?.[0]?.gateConfig).toEqual(gateConfig)
      expect(created.body.stepOptions?.[1]?.gateConfig).toEqual({ fields: { maxAttempts: 3 } })

      const snapshot = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      const stored = snapshot.body.pipelines.find((p) => p.id === created.body.id)!
      expect(stored.stepOptions?.[0]?.gateConfig).toEqual(gateConfig)
      expect(stored.stepOptions?.[1]?.gateConfig).toEqual({ fields: { maxAttempts: 3 } })
    })

    it('refuses gate config that has no gate to configure, on every facade', async () => {
      // The three refusals `assertValidGateConfig` makes, each of which would otherwise land as
      // configuration nobody reads or a run that parks forever. Asserted cross-runtime because
      // the gate registry the parameter check consults is facade-wired: a facade that forgot to
      // thread it would accept a pipeline the other refuses.
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      const ungated = await call('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Policy without a gate',
        agentKinds: ['coder', 'merger'],
        stepOptions: [{ gateConfig: { approvers: { roles: ['admin'] } } }, null],
      })
      expect(ungated.status).toBe(422)

      const unreachableQuorum = await call('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Quorum nobody can reach',
        agentKinds: ['coder', 'merger'],
        gates: [true, false],
        stepOptions: [
          { gateConfig: { approvers: { userIds: ['usr_only_one'] }, minApprovals: 2 } },
          null,
        ],
      })
      expect(unreachableQuorum.status).toBe(422)

      const undeclaredParameter = await call('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Parameter no gate declares',
        agentKinds: ['coder', 'ci', 'merger'],
        stepOptions: [null, { gateConfig: { fields: { nosuchknob: 3 } } }, null],
      })
      expect(undeclaredParameter.status).toBe(422)
    })
  })
}

/**
 * Task types, the real-time board event a human mutation pushes, and the per-service
 * running-task limit.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerBoardPlanningTests(harness: ConformanceHarness): void {
  describe('task types + per-service running-task limit', () => {
    it('persists a task type + per-type fields, surfaced on the snapshot identically', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      const created = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'Investigate flaky login',
        taskType: 'bug',
        taskTypeFields: { severity: 'high', stepsToReproduce: 'log in repeatedly' },
      })
      expect(created.status).toBe(201)
      expect(created.body.taskType).toBe('bug')

      // The type + its per-type fields round-trip through the store identically (D1 ⇄ Postgres).
      const snapshot = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      const block = snapshot.body.blocks.find((b) => b.id === created.body.id)!
      expect(block.taskType).toBe('bug')
      expect(block.taskTypeFields?.severity).toBe('high')
    })

    it('pushes a real-time board event for human board mutations (add/rename/delete)', async () => {
      // Other users active on a workspace must learn of a board edit live, not only on
      // refresh, so every board mutation emits a `boardChanged`. Asserted on every
      // runtime so a facade can't silently drop the push.
      const { call, createWorkspace, boardEmits } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      // Add → emits naming the new block.
      const created = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'A collaboratively visible task',
      })
      expect(created.status).toBe(201)
      expect(boardEmits(created.body.id).length).toBeGreaterThan(0)

      // Rename → another event for the same block.
      const before = boardEmits(created.body.id).length
      const renamed = await call('PATCH', `/workspaces/${wsId}/blocks/${created.body.id}`, {
        title: 'Renamed live',
      })
      expect(renamed.status).toBe(200)
      expect(boardEmits(created.body.id).length).toBeGreaterThan(before)

      // Delete → a removal signal reaches the workspace too.
      const removed = await call('DELETE', `/workspaces/${wsId}/blocks/${created.body.id}`)
      expect(removed.status).toBe(204)
      expect(boardEmits().some((e) => e.reason === 'block-removed')).toBe(true)
    })

    it('carries the block on a task mutation and withholds it on a structural one', async () => {
      // A board event either CARRIES the changed block (subscribers upsert it and pay one small
      // payload) or only names one (every open board re-reads a whole snapshot). Getting that
      // wrong is silent in both directions: a withheld payload just costs a refresh nobody
      // notices in a test, and a payload that should have been withheld renders stale state.
      // The block round-trips through each runtime's own store on the way here, so this belongs
      // on both rather than on whichever facade a feature spec happened to use.
      const { call, createWorkspace, boardEmits } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      // A task is fully described by itself: add and edit both carry it.
      const created = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'Patch me in place',
      })
      expect(created.status).toBe(201)
      const added = boardEmits(created.body.id)
      expect(added.at(-1)?.hasBlock, 'a spawned task rides along').toBe(true)
      expect(added.at(-1)?.blockId).toBe(created.body.id)

      const renamed = await call('PATCH', `/workspaces/${wsId}/blocks/${created.body.id}`, {
        title: 'Still patchable',
      })
      expect(renamed.status).toBe(200)
      expect(boardEmits(created.body.id).at(-1)?.hasBlock, 'an edited task rides along').toBe(true)

      // A service FRAME does not: its position and size are a per-board mount override, so one
      // payload cannot be correct on the several boards a shared service's event reaches.
      const frame = await call<Block>('POST', `/workspaces/${wsId}/blocks`, {
        type: 'service',
        position: { x: 500, y: 500 },
      })
      expect(frame.status).toBe(201)
      expect(boardEmits(frame.body.id).at(-1)?.hasBlock, 'a frame is per-board').toBe(false)

      // Nor does a delete: it cascades onto rows the event never names.
      const removed = await call('DELETE', `/workspaces/${wsId}/blocks/${created.body.id}`)
      expect(removed.status).toBe(204)
      const removal = boardEmits().filter((e) => e.reason === 'block-removed')
      expect(removal.at(-1)?.hasBlock, 'a cascade cannot be stated by one block').toBe(false)
    })

    it('enforces a per-service running-task limit and lifts it when the mode is off', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      const pipeline = await call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Code only',
        agentKinds: ['coder'],
      })
      // Cap the auth service at one concurrently-running task.
      const settings = await call('PUT', `/workspaces/${wsId}/settings`, {
        taskLimitMode: 'shared',
        taskLimitShared: 1,
      })
      expect(settings.status).toBe(200)

      // A second task under the same service frame (blk_auth owns task_login).
      const second = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'Second task',
      })
      expect(second.status).toBe(201)

      // First run starts and stays running (the suite's no-op runner never drives it).
      const first = await call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(first.status).toBe(201)

      // The service is now at its cap: a second start is refused with a 409 conflict.
      const blocked = await call(
        'POST',
        `/workspaces/${wsId}/blocks/${second.body.id}/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(blocked.status).toBe(409)

      // Turning the limit off lets the second task start.
      await call('PUT', `/workspaces/${wsId}/settings`, { taskLimitMode: 'off' })
      const allowed = await call(
        'POST',
        `/workspaces/${wsId}/blocks/${second.body.id}/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(allowed.status).toBe(201)
    })
  })
}

/**
 * The bounded, keyset-paginated JOB and SERVICE-TASK lists, whose page size and cursor shape
 * must be identical on every store.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerPublicApiListTests(harness: ConformanceHarness): void {
  it('serves the bounded, keyset-paginated JOB list identically on every store', async () => {
    const { call, createOrgWorkspace, drive } = harness.makeApp()
    const { workspace } = await createOrgWorkspace({ seed: true })
    const wsId = workspace.id
    const created = await call<{ secret: string }>('POST', `/workspaces/${wsId}/public-api-keys`, {
      label: 'external',
    })
    const auth = { authorization: `Bearer ${created.body.secret}` }

    // Three headless initiative runs, driven to completion so they settle `succeeded`.
    for (const input of ['job one', 'job two', 'job three']) {
      expect(
        (await call('POST', '/api/v1/jobs', { pipelineId: 'pl_initiative_breakdown', input }, auth))
          .status,
      ).toBe(202)
    }
    await drive(wsId)

    type JobPage = { jobs: { jobId: string; status: string }[]; nextCursor: string | null }
    const all = await call<JobPage>('GET', '/api/v1/jobs', undefined, auth)
    expect(all.status).toBe(200)
    expect(all.body.jobs.length).toBe(3)
    // Newest first, and the last page reports no further cursor.
    expect(all.body.nextCursor).toBeNull()
    expect(all.body.jobs.every((j) => j.status === 'succeeded')).toBe(true)
    const order = all.body.jobs.map((j) => j.jobId)

    // Keyset paging: two pages of 2 + 1 reproduce the single-page order exactly, with no row
    // skipped or repeated (the composite `(createdAt, id)` cursor is what makes this hold for
    // runs that share a millisecond — a timestamp-only cursor would drop the ties).
    const first = await call<JobPage>('GET', '/api/v1/jobs?limit=2', undefined, auth)
    expect(first.body.jobs.map((j) => j.jobId)).toEqual(order.slice(0, 2))
    expect(first.body.nextCursor).toBeTruthy()
    const second = await call<JobPage>(
      'GET',
      `/api/v1/jobs?limit=2&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
      undefined,
      auth,
    )
    expect(second.body.jobs.map((j) => j.jobId)).toEqual(order.slice(2))
    expect(second.body.nextCursor).toBeNull()

    // Walk the whole list one row at a time: every job must be visited EXACTLY once, in the
    // same order, and the walk must terminate. This is the general keyset guard — a cursor
    // minted from anything other than the value the query orders by (the `agent_runs.created_at`
    // COLUMN, which `rowToExecution` projects onto `createdAt` for exactly this reason) skips or
    // repeats rows here. The same-millisecond tie is pinned at the mapper/unit level, since a
    // conformance run cannot force two inserts into one clock tick.
    const walked: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard <= order.length; guard++) {
      const url: string = `/api/v1/jobs?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const page: { status: number; body: JobPage } = await call<JobPage>(
        'GET',
        url,
        undefined,
        auth,
      )
      walked.push(...page.body.jobs.map((j) => j.jobId))
      cursor = page.body.nextCursor
      if (!cursor) break
    }
    expect(cursor).toBeNull()
    expect(walked).toEqual(order)

    // Filters: a status nothing matches comes back empty; a future `since` likewise.
    const failedOnly = await call<JobPage>('GET', '/api/v1/jobs?status=failed', undefined, auth)
    expect(failedOnly.body.jobs).toEqual([])
    const future = await call<JobPage>(
      'GET',
      `/api/v1/jobs?since=${Date.now() + 60_000}`,
      undefined,
      auth,
    )
    expect(future.body.jobs).toEqual([])

    // A malformed cursor is an explicit 400, never a silent re-serve of page 1.
    const bad = await call<{ error: { code: string } }>(
      'GET',
      '/api/v1/jobs?cursor=!!!not-base64!!!',
      undefined,
      auth,
    )
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('invalid_cursor')

    // A junk `limit`/`since` is rejected at the contract, not silently coerced: `Number()` would
    // read `1e9` and `0x64` as plausible page sizes and blow straight past the hard ceiling.
    for (const query of ['limit=abc', 'limit=0', 'limit=101', 'limit=1e2', 'since=yesterday']) {
      expect((await call('GET', `/api/v1/jobs?${query}`, undefined, auth)).status).toBe(400)
    }

    // The `internal` scope is enforced in SQL: an ORDINARY board run in the same workspace is
    // never enumerated, mirroring the single-job read's 404. This is the list form of the
    // double-scope, and the assertion that would catch a store that dropped the anchor join.
    expect(
      (
        await call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: 'pl_initiative_breakdown',
        })
      ).status,
    ).toBe(201)
    const boardRun = (await drive(wsId)).find((e) => e.blockId === 'task_login')!
    const afterBoardRun = await call<JobPage>('GET', '/api/v1/jobs', undefined, auth)
    expect(afterBoardRun.body.jobs.some((j) => j.jobId === boardRun.id)).toBe(false)
    expect(afterBoardRun.body.jobs.length).toBe(3)
  })

  it('serves the bounded, keyset-paginated SERVICE-TASK list identically on every store', async () => {
    const { call, createOrgWorkspace } = harness.makeApp()
    const { workspace } = await createOrgWorkspace({ seed: true })
    const wsId = workspace.id
    const created = await call<{ secret: string }>('POST', `/workspaces/${wsId}/public-api-keys`, {
      label: 'external',
    })
    const auth = { authorization: `Bearer ${created.body.secret}` }

    const frame = await call<{ id: string }>('POST', `/workspaces/${wsId}/blocks`, {
      type: 'service',
      position: { x: 900, y: 900 },
    })
    const serviceId = frame.body.id
    // A module under the frame, so the page covers the WHOLE subtree — a task directly under
    // the frame AND one nested in a module. That two-level walk is exactly what the new
    // `listChildIds` + `listTasksUnder` pair replaces the old whole-board read with.
    const module = await call<{ id: string }>(
      'POST',
      `/workspaces/${wsId}/blocks/${serviceId}/modules`,
      { name: 'Module A' },
    )
    const underFrame = await call<{ taskId: string }>(
      'POST',
      `/api/v1/services/${serviceId}/tasks`,
      { title: 'Task under frame' },
      auth,
    )
    const underModule = await call<{ id: string }>(
      'POST',
      `/workspaces/${wsId}/blocks/${module.body.id}/tasks`,
      { title: 'Task under module' },
    )

    type TaskPage = {
      tasks: { taskId: string; status: string }[]
      nextCursor: string | null
    }
    const tasks = await call<TaskPage>(
      'GET',
      `/api/v1/services/${serviceId}/tasks`,
      undefined,
      auth,
    )
    expect(tasks.status).toBe(200)
    expect(new Set(tasks.body.tasks.map((t) => t.taskId))).toEqual(
      new Set([underFrame.body.taskId, underModule.body.id]),
    )
    expect(tasks.body.nextCursor).toBeNull()
    // Both stores order by the same stable key, so the paged sequence must equal the unpaged one.
    const taskOrder = tasks.body.tasks.map((t) => t.taskId)

    const tFirst = await call<TaskPage>(
      'GET',
      `/api/v1/services/${serviceId}/tasks?limit=1`,
      undefined,
      auth,
    )
    expect(tFirst.body.tasks.map((t) => t.taskId)).toEqual(taskOrder.slice(0, 1))
    expect(tFirst.body.nextCursor).toBeTruthy()
    const tSecond = await call<TaskPage>(
      'GET',
      `/api/v1/services/${serviceId}/tasks?limit=1&cursor=${encodeURIComponent(tFirst.body.nextCursor!)}`,
      undefined,
      auth,
    )
    expect(tSecond.body.tasks.map((t) => t.taskId)).toEqual(taskOrder.slice(1))
    expect(tSecond.body.nextCursor).toBeNull()

    // The status filter is pushed into SQL: both fresh tasks are `planned`, none are `done`.
    const planned = await call<TaskPage>(
      'GET',
      `/api/v1/services/${serviceId}/tasks?status=planned`,
      undefined,
      auth,
    )
    expect(planned.body.tasks.length).toBe(2)
    const done = await call<TaskPage>(
      'GET',
      `/api/v1/services/${serviceId}/tasks?status=done`,
      undefined,
      auth,
    )
    expect(done.body.tasks).toEqual([])

    // A missing / non-service target still 404s (the guard survives the move to a paged read).
    expect((await call('GET', `/api/v1/services/nope/tasks`, undefined, auth)).status).toBe(404)
  })
}
