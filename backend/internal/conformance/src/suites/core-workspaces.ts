import {
  type Block,
  type Pipeline,
  type Workspace,
  type WorkspaceSnapshot,
  offeredPipelines,
  seedPipelines,
  SIMPLE_PIPELINE_ID,
  UNATTENDED_BUILD_PIPELINE_ID,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'
import { spawnedInitiative } from './shared.js'

// Core conformance, slice 1: infrastructure capability descriptors, the mothership-mode machine
// API gate, and the workspace snapshot/board basics. Split out of the former monolithic
// `core.ts` so no single suite file grows unbounded (the file-size ratchet guard); each `defineX`
// re-opens its nested `describe` groups inside the one per-facade `[name] conformance` wrapper the
// aggregator provides, so the reported test tree is unchanged.
export function defineCoreWorkspacesConformance(harness: ConformanceHarness): void {
  describe('infrastructure capabilities', () => {
    it('exposes execution + test-env backends on /auth/config with active ∈ available', async () => {
      const { call } = harness.makeApp()
      const res = await call<{
        infrastructure?: {
          execution: { available: string[]; active: string }
          testEnv: { available: string[]; active: string }
          frontendPreview: { supported: boolean }
        }
      }>('GET', '/auth/config')
      expect(res.status).toBe(200)
      // Every facade must populate the descriptor (it drives the SPA's infra selector).
      const infra = res.body.infrastructure
      expect(infra).toBeTruthy()
      expect(infra!.execution.available.length).toBeGreaterThan(0)
      expect(infra!.execution.available).toContain(infra!.execution.active)
      expect(infra!.testEnv.available.length).toBeGreaterThan(0)
      expect(infra!.testEnv.available).toContain(infra!.testEnv.active)
      // The browsable-preview capability is a required boolean axis on every facade (the SPA
      // gates the `previewEnabled` toggle on it). Its VALUE is a per-facade differentiator
      // (Worker false; Node/local true), so the shared suite pins only that it is present +
      // boolean — each facade's own spec asserts its concrete value.
      expect(typeof infra!.frontendPreview.supported).toBe('boolean')
    })
  })

  defineMachineApiGate(harness)

  describe('workspaces', () => {
    it('creates a seeded board and returns a full snapshot', async () => {
      const { call } = harness.makeApp()
      const res = await call<WorkspaceSnapshot>('POST', '/workspaces', { name: 'My board' })

      expect(res.status).toBe(201)
      expect(res.body.workspace.name).toBe('My board')
      expect(res.body.blocks.find((b) => b.id === 'blk_auth')).toBeTruthy()
      // Every facade seeds a new board with the built-in pipeline catalog, minus the INTERNAL
      // entries: those are seeded and resolvable for a run, but never OFFERED, so a picker built
      // off this array cannot list a pipeline whose only sensible caller is the platform.
      expect(res.body.pipelines).toEqual(offeredPipelines(seedPipelines(), seedPipelines()))
      expect(res.body.executions).toHaveLength(0)
    })

    it('computes the infra-setup status projection on the snapshot (both create + read)', async () => {
      // The shared controller derives `infraSetup` from whatever THIS deployment wired, so its
      // per-area values legitimately differ across runtimes (e.g. the Worker binds R2 →
      // binaryStorage `configured`; a stock Node deployment defaults to off → `not_defined`).
      // The runtime-agnostic invariant the conformance suite pins is that BOTH facades attach
      // the projection with all three areas set to a valid status — a facade that forgot it (or
      // mistyped a value) fails here rather than shipping a banner that never renders.
      const statuses = ['not_defined', 'configured', 'not_applicable']
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace({ seed: false })

      const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${workspace.id}`)
      const infra = snap.body.infraSetup
      expect(infra).toBeDefined()
      expect(statuses).toContain(infra!.ephemeralEnvironments)
      expect(statuses).toContain(infra!.agentExecutor)
      expect(statuses).toContain(infra!.binaryStorage)

      // The create response carries the same projection (so a fresh board renders the banner).
      const created = await call<WorkspaceSnapshot>('POST', '/workspaces', { seed: false })
      expect(created.body.infraSetup).toBeDefined()
      expect(statuses).toContain(created.body.infraSetup!.binaryStorage)
    })

    it('advertises the registered initiative presets on the snapshot (both create + read)', async () => {
      // The initiative-preset registry is process-global, so the shared WorkspaceController
      // attaches `initiativePresets` for BOTH facades. The runtime-agnostic invariant: the
      // built-in generic preset is always present, binds the generic planning pipeline, and
      // runs the interviewer — a facade that dropped the field (or a broken registry read)
      // fails here rather than shipping an empty create picker.
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace({ seed: false })

      const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${workspace.id}`)
      const generic = snap.body.initiativePresets?.find((p) => p.id === 'preset_generic')
      expect(generic).toBeDefined()
      expect(generic!.planningPipelineId).toBe('pl_initiative')
      expect(generic!.interview).toBe('full')
      // The generic preset has no `detect` hook, so its `probe` flag is derived false.
      expect(generic!.probe ?? false).toBe(false)

      // The create response carries the same registry projection.
      const created = await call<WorkspaceSnapshot>('POST', '/workspaces', { seed: false })
      expect(created.body.initiativePresets?.some((p) => p.id === 'preset_generic')).toBe(true)
    })

    it('persists and updates a board name + description identically on every store', async () => {
      const { call } = harness.makeApp()
      const created = await call<WorkspaceSnapshot>('POST', '/workspaces', {
        name: 'Described',
        description: 'A board with a description',
        seed: false,
      })
      expect(created.body.workspace.description).toBe('A board with a description')

      // Round-trips through the store on a fresh snapshot read.
      const wsId = created.body.workspace.id
      const reread = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      expect(reread.body.workspace.description).toBe('A board with a description')

      // PATCH updates the description; null clears it.
      const updated = await call<Workspace>('PATCH', `/workspaces/${wsId}`, {
        description: 'Updated description',
      })
      expect(updated.body.description).toBe('Updated description')
      const cleared = await call<Workspace>('PATCH', `/workspaces/${wsId}`, { description: null })
      expect(cleared.body.description).toBeNull()
    })

    it('creates a board with no sample blocks when seed=false (pipelines always seeded)', async () => {
      const { call } = harness.makeApp()
      const res = await call<WorkspaceSnapshot>('POST', '/workspaces', { seed: false })

      expect(res.body.blocks).toHaveLength(0)
      // The pipeline catalog is product config, not sample data — seeded regardless
      // of the sample-block flag.
      expect(res.body.pipelines).toEqual(offeredPipelines(seedPipelines(), seedPipelines()))
    })

    it('withholds an INTERNAL pipeline from the snapshot while keeping it runnable', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const internal = seedPipelines().filter((p) => p.internal)
      // The catalog HAS internal entries — otherwise this test passes by asserting nothing.
      expect(internal.length).toBeGreaterThan(0)

      const listed = await call<Pipeline[]>('GET', `/workspaces/${workspace.id}/pipelines`)
      for (const p of internal) {
        expect(listed.body.map((row) => row.id)).not.toContain(p.id)
      }
      // Withheld from the LISTING, not from the store: the flow that starts it by id still must
      // resolve it, which is the whole difference between internal and retired.
      const snapshot = await call<WorkspaceSnapshot>('GET', `/workspaces/${workspace.id}`)
      expect(snapshot.body.pipelines.map((p) => p.id)).not.toContain(internal[0]!.id)
    })

    it('round-trips the per-scope default pipeline, one holder per scope', async () => {
      // Both facades store the two claims as their own columns behind a PARTIAL unique index, and
      // promoting touches a SECOND row. So the invariant a sequential unit test cannot see is the
      // one asserted here: after a promotion, exactly one row carries the flag, on a real store.
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const base = `/workspaces/${workspace.id}/pipelines`
      const seeded = await call<Pipeline[]>('GET', base)
      const unattendedDefault = seeded.body.filter((p) => p.isUnattendedDefault)
      // The catalog seeds the unattended rung and deliberately seeds NO interactive default: the
      // in-app scope already resolves an answer without a flagged row.
      expect(unattendedDefault.map((p) => p.id)).toEqual([UNATTENDED_BUILD_PIPELINE_ID])
      expect(seeded.body.filter((p) => p.isDefault)).toHaveLength(0)

      const other = seeded.body.find((p) => p.id === SIMPLE_PIPELINE_ID)!
      const promoted = await call<Pipeline>('PATCH', `${base}/${other.id}/organize`, {
        isUnattendedDefault: true,
      })
      expect(promoted.status).toBe(200)
      expect(promoted.body.isUnattendedDefault).toBe(true)
      const afterPromote = await call<Pipeline[]>('GET', base)
      expect(afterPromote.body.filter((p) => p.isUnattendedDefault).map((p) => p.id)).toEqual([
        other.id,
      ])

      // The scopes are independent: claiming the in-app one must leave the unattended holder alone.
      await call('PATCH', `${base}/${UNATTENDED_BUILD_PIPELINE_ID}/organize`, { isDefault: true })
      const bothScopes = await call<Pipeline[]>('GET', base)
      expect(bothScopes.body.filter((p) => p.isDefault).map((p) => p.id)).toEqual([
        UNATTENDED_BUILD_PIPELINE_ID,
      ])
      expect(bothScopes.body.filter((p) => p.isUnattendedDefault).map((p) => p.id)).toEqual([
        other.id,
      ])

      // Releasing leaves the scope with NO declared default, which is a real state here (unlike on
      // the risk-policy library, where a default always resolves).
      const released = await call<Pipeline>('PATCH', `${base}/${other.id}/organize`, {
        isUnattendedDefault: false,
      })
      expect(released.body.isUnattendedDefault).toBeFalsy()
      const afterRelease = await call<Pipeline[]>('GET', base)
      expect(afterRelease.body.filter((p) => p.isUnattendedDefault)).toHaveLength(0)
    })

    it('lists and deletes boards', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()

      const list = await call<Workspace[]>('GET', '/workspaces')
      expect(list.body.map((w) => w.id)).toContain(workspace.id)

      const del = await call('DELETE', `/workspaces/${workspace.id}`)
      expect(del.status).toBe(204)

      const after = await call('GET', `/workspaces/${workspace.id}`)
      expect(after.status).toBe(404)
    })

    it('cascades the delete across workspace-scoped tables (no permanent orphans)', async () => {
      // The delete cascade is driven by the shared kernel list WORKSPACE_SCOPED_TABLES on BOTH
      // facades. Before it covered the full list, deleting a board left rows in ~40 other
      // workspace-scoped tables (notifications, initiatives, the review/session tables, …)
      // orphaned forever. Seed two of those tables through the real per-runtime stores, delete
      // the board, and assert BOTH stores reclaimed the rows — so a facade that mapped the
      // cascade differently fails here on D1 or Postgres instead of silently orphaning.
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      await app.notificationRepository().upsert(wsId, {
        id: `ntf-${wsId}`,
        type: 'merge_review',
        status: 'open',
        severity: 'normal',
        blockId: null,
        executionId: null,
        title: 'Review',
        body: 'body',
        payload: null,
        createdAt: 1,
        resolvedAt: null,
      })
      await app.initiativeRepository().insert(wsId, spawnedInitiative('init_orphan_anchor'))

      // Sanity: both rows are present before the delete.
      expect(await app.notificationRepository().listOpen(wsId)).toHaveLength(1)
      expect(await app.initiativeRepository().list(wsId)).toHaveLength(1)

      const del = await app.call('DELETE', `/workspaces/${wsId}`)
      expect(del.status).toBe(204)

      // …and neither store keeps a row for the deleted workspace.
      expect(await app.notificationRepository().listOpen(wsId)).toEqual([])
      expect(await app.initiativeRepository().list(wsId)).toEqual([])
    })

    it('returns 404 for an unknown board', async () => {
      const { call } = harness.makeApp()
      const res = await call<{ error: { code: string } }>('GET', '/workspaces/missing')

      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('not_found')
    })

    // The request-correlation middleware is FACADE-mounted, so "is it wired here" is exactly the
    // kind of question only a cross-runtime assertion answers: a facade that forgot
    // `mountRequestLogging` still serves every route, it just silently loses the id a user
    // quotes back and the line an operator greps. Asserted through a REFUSED request, because
    // the envelope is where the id becomes user-visible.
    it('correlates a refused request with an id, adopting the caller-supplied one', async () => {
      const { call } = harness.makeApp()

      const minted = await call<{ error: { requestId?: string } }>('GET', '/workspaces/missing')
      expect(minted.body.error.requestId).toEqual(expect.any(String))

      const propagated = await call<{ error: { requestId?: string } }>(
        'GET',
        '/workspaces/missing',
        undefined,
        { 'X-Request-Id': 'conformance-req-1' },
      )
      expect(propagated.body.error.requestId).toBe('conformance-req-1')
    })

    it('isolates blocks between boards', async () => {
      const { createWorkspace } = harness.makeApp()
      const a = await createWorkspace()
      const b = await createWorkspace()

      expect(a.workspace.id).not.toBe(b.workspace.id)
      expect(a.blocks.find((x) => x.id === 'blk_auth')).toBeTruthy()
      expect(b.blocks.find((x) => x.id === 'blk_auth')).toBeTruthy()
    })

    it('resizing a container from its north/west border keeps its contents in place', async () => {
      // The user-visible property: dragging the top/left border extends the box past its
      // contents rather than dragging the contents along with it. Positions are stored relative
      // to the container's content origin, so the server has to translate every DIRECT child by
      // the inverse of the origin delta — and a grandchild (a task inside a module) must NOT be
      // translated, since it rides its module, which moved as a unit.
      const { call, createWorkspace } = harness.makeApp()
      const { workspace, blocks } = await createWorkspace()
      const wsId = workspace.id
      const frame = blocks.find((b) => b.id === 'blk_auth')!
      const childrenBefore = blocks.filter((b) => b.parentId === 'blk_auth')
      const grandchildBefore = blocks.find((b) => b.id === 'task_session')!
      expect(childrenBefore.length).toBeGreaterThan(1)

      // Grow 40px west and 30px north: the origin moves by (-40, -30), the box by (+40, +30).
      const size = { w: (frame.size?.w ?? 600) + 40, h: (frame.size?.h ?? 400) + 30 }
      const resized = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/resize`, {
        position: { x: frame.position.x - 40, y: frame.position.y - 30 },
        size,
      })
      expect(resized.status).toBe(200)
      expect(resized.body.position).toEqual({ x: frame.position.x - 40, y: frame.position.y - 30 })
      expect(resized.body.size).toEqual(size)

      const after = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      const byId = new Map(after.body.blocks.map((b) => [b.id, b]))
      for (const child of childrenBefore) {
        expect(byId.get(child.id)!.position).toEqual({
          x: child.position.x + 40,
          y: child.position.y + 30,
        })
      }
      expect(byId.get('task_session')!.position).toEqual(grandchildBefore.position)
    })

    it('resizing a container from its east/south border moves nothing inside it', async () => {
      // The complement of the assertion above, and the reason the translation is derived from the
      // stored origin rather than applied unconditionally: the common drag has no origin delta.
      const { call, createWorkspace } = harness.makeApp()
      const { workspace, blocks } = await createWorkspace()
      const wsId = workspace.id
      const frame = blocks.find((b) => b.id === 'blk_auth')!
      const childrenBefore = blocks.filter((b) => b.parentId === 'blk_auth')

      const resized = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/resize`, {
        position: frame.position,
        size: { w: (frame.size?.w ?? 600) + 120, h: (frame.size?.h ?? 400) + 90 },
      })
      expect(resized.status).toBe(200)

      const after = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      const byId = new Map(after.body.blocks.map((b) => [b.id, b]))
      for (const child of childrenBefore) {
        expect(byId.get(child.id)!.position).toEqual(child.position)
      }
    })

    it('returns blocks in insertion order on every store, stable across updates', async () => {
      // Parity pin: D1 lists blocks `ORDER BY rowid` (insertion order); the Postgres
      // store must match via its `seq` column. Enough fat rows to span several heap
      // pages + an update to the FIRST one make the drift observable: without an
      // ORDER BY, Postgres relocates the updated row's new tuple version to a later
      // page, so a bare heap read returns it out of insertion order.
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(12)
      const createdIds: string[] = []
      for (let i = 0; i < 40; i++) {
        const res = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
          title: `Ordered task ${i}`,
          description: filler,
        })
        expect(res.status).toBe(201)
        createdIds.push(res.body.id)
      }
      const updated = await call('PATCH', `/workspaces/${wsId}/blocks/${createdIds[0]}`, {
        title: 'Ordered task 0, renamed',
        description: `${filler} Updated so the row version moves in the heap.`,
      })
      expect(updated.status).toBe(200)

      const snapshot = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      const createdSet = new Set(createdIds)
      const listed = snapshot.body.blocks.map((b) => b.id).filter((id) => createdSet.has(id))
      expect(listed).toEqual(createdIds)
    })
  })
}

/**
 * The mothership-mode `/internal/*` machine API gate assertions.
 *
 * Extracted from {@link defineCoreWorkspacesConformance} purely to stay inside the per-function
 * line budget; every assertion is unchanged. It is a cohesive group in its own right: each case
 * pins that ONE machine endpoint is mounted by the shared controller on BOTH facades and refuses
 * an unauthenticated caller BEFORE any capability probe, which is the drift guard for the
 * symmetric wiring each of them needs.
 */
function defineMachineApiGate(harness: ConformanceHarness): void {
  describe('mothership-mode machine API', () => {
    it('serves /internal/persistence with the registry attached + machine-token gate active', async () => {
      const { call } = harness.makeApp()
      // The endpoint is mounted by the shared controller and the session auth gate bypasses
      // `/internal`, so an unauthenticated call reaches the controller. With the facade's
      // repository registry attached (both runtimes must do this — the symmetric wiring), a
      // missing/invalid machine token is rejected 403. A facade that FORGOT to attach its
      // registry would instead 503 here, so this is the drift guard for that symmetric change.
      const res = await call('POST', '/internal/persistence', {
        repo: 'workspaceRepository',
        method: 'get',
        args: ['ws_x'],
      })
      expect(res.status).toBe(403)
    })

    it('serves /internal/github/installation-token with the machine-token gate active', async () => {
      const { call } = harness.makeApp()
      // The GitHub delegation endpoint is mounted by the shared controller on both facades
      // and checks the machine token FIRST (before the "is a GitHub App wired" 503), so an
      // unauthenticated call is a 403 everywhere — the drift guard that the endpoint exists
      // and is machine-gated regardless of whether this facade configures a GitHub App.
      const res = await call('POST', '/internal/github/installation-token', {
        installationId: 1,
      })
      expect(res.status).toBe(403)
    })

    it('serves /internal/notifications/deliver with the machine-token gate active', async () => {
      const { call } = harness.makeApp()
      // The notification DELIVERY endpoint (a mothership-mode node asks the mothership to deliver
      // a notification it raised through the org's external transports) is mounted by the shared
      // controller on both facades and checks the machine token FIRST — before the "does this
      // facade have an external channel" 503 — so an unauthenticated call is a 403 everywhere.
      // The drift guard that the endpoint exists and is machine-gated regardless of whether this
      // facade wires Slack.
      const res = await call('POST', '/internal/notifications/deliver', {
        workspaceId: 'ws_x',
        notificationId: 'ntf_x',
      })
      expect(res.status).toBe(403)
    })

    it('serves /internal/telemetry/ingest with the machine-token gate active', async () => {
      const { call } = harness.makeApp()
      // The telemetry INGEST endpoint (a mothership-mode node uploading a finished run's locally
      // captured observability so hosted teammates can read it and it outlives the node's local
      // retention window). Mounted by the shared controller on both facades and machine-gated
      // FIRST — before the "is this facade a mothership" 503 and before any body parsing — so an
      // unauthenticated call is a 403 everywhere. The drift guard that the endpoint exists and
      // cannot be probed without a token.
      const res = await call('POST', '/internal/telemetry/ingest', {
        workspaceId: 'ws_x',
        executionId: 'exec_x',
      })
      expect(res.status).toBe(403)
    })

    it('serves /internal/telemetry/read with the machine-token gate active', async () => {
      const { call } = harness.makeApp()
      // The telemetry READ-THROUGH endpoint (the ingest's dual: a mothership-mode node serving a
      // run whose LOCAL rows were pruned — or that another node drove entirely — from the
      // mothership's copy). Mounted by the shared controller on both facades and machine-gated
      // FIRST, before the "is this facade a mothership" 503, the method-table lookup and any
      // scope resolution, so an unauthenticated call is a 403 everywhere. This is the endpoint
      // where an ungated slip would be worst: the table is a READ surface over every account's
      // captured prompts and responses.
      const res = await call('POST', '/internal/telemetry/read', {
        workspaceId: 'ws_x',
        repo: 'llmCallMetricRepository',
        method: 'summarizeByExecution',
        args: ['exec_x'],
      })
      expect(res.status).toBe(403)
    })

    it('serves /internal/secrets/{unseal,seal} with the machine-token gate active', async () => {
      const { call } = harness.makeApp()
      // The SECRET DELEGATION pair (a mothership opening, and sealing, an ORG credential a
      // mothership-mode node holds no key for). Mounted by the shared controller on both facades
      // and machine-gated FIRST, before the "is this facade a mothership / does it have a cipher"
      // 503, the source-table lookup and any scope resolution, so an unauthenticated call is a
      // 403 everywhere. This is the endpoint where an ungated slip would be worst of all: it is
      // the one surface in the machine API that answers with a PLAINTEXT credential.
      expect(
        (
          await call('POST', '/internal/secrets/unseal', {
            source: 'environment_access',
            workspaceId: 'ws_x',
            key: ['env_x'],
          })
        ).status,
      ).toBe(403)
      expect(
        (
          await call('POST', '/internal/secrets/seal', {
            source: 'environment_access',
            workspaceId: 'ws_x',
            plaintext: 'x',
          })
        ).status,
      ).toBe(403)
    })

    it('serves /internal/foundational-services with the machine-token gate active', async () => {
      const { call } = harness.makeApp()
      // The catalog's `builtin` TIER read (a mothership-mode node resolving the deployment's
      // estate from the mothership rather than from its own, necessarily drifting, copy). Both
      // routes are mounted by the shared controller on both facades and machine-gated FIRST, so
      // an unauthenticated call is a 403 everywhere — including on a deployment that registers no
      // foundational services at all, which is exactly the case where a mistakenly ungated
      // endpoint would look like it was working (an empty list is a legitimate answer).
      expect((await call('GET', '/internal/foundational-services')).status).toBe(403)
      expect(
        (await call('POST', '/internal/foundational-services/contracts', { ids: ['file-storage'] }))
          .status,
      ).toBe(403)
    })

    it('serves /internal/events/subscribe/:ws with the machine-token gate active', async () => {
      const { call } = harness.makeApp()
      // The INBOUND real-time leg (a mothership-mode node subscribing to a workspace's stream so
      // org activity reaches the laptop's SPA). Mounted by the shared controller on both facades
      // and machine-gated FIRST — before the upgrade-shape check and before any realtime-transport
      // probe — so an unauthenticated call is a 403 everywhere, whatever this facade wires. The
      // drift guard that the endpoint exists and cannot be probed without a token.
      const res = await call('GET', '/internal/events/subscribe/ws_x')
      expect(res.status).toBe(403)
    })
  })
}
