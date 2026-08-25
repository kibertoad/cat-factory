import type { PublicAttachedDocumentList, PublicRepoList, PublicTask } from '@cat-factory/contracts'
import { createBackendRegistries } from '@cat-factory/integrations'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'
import { mintPublicApiKey } from './shared.js'

// Cross-runtime conformance for the public BOARD-PROVISIONING surface (`GET /api/v1/repos`, the
// adopt pair `GET /api/v1/repos/available` + `POST /api/v1/repos/link`, and `POST` / `DELETE
// /api/v1/services`) and for the two task relationships that outlive a create call (dependency
// edges, attached requirements documents).
//
// What belongs HERE rather than in a unit test is the half a unit test structurally cannot see:
// that each facade MOUNTS these routes, and that the writes land in its OWN store, so a facade
// that shipped the controller but forgot a wiring answers 404/503 instead of shipping a surface
// a headless deployment silently cannot provision itself with.
//
// See backend/docs/public-api.md and backend/docs/adr/0050-public-api-headless-completeness.md.

/**
 * Three groups, three functions: the sequence a caller PROVISIONS a board with, then the two task
 * relationships that outlive a create call. Split because each is a cohesive read of one surface
 * and the suite is written to a per-function line budget, not because the harness needs three.
 */
export function definePublicBoardConformance(harness: ConformanceHarness): void {
  defineServiceProvisioning(harness)
  defineCustomProvisioningPins(harness)
  defineTaskDependencies(harness)
  defineTaskDocuments(harness)
}

/**
 * The `custom` provisioning pin's two reads: the catalog an id can be checked against, and taking
 * a pin back.
 *
 * Facade-run because only a facade shows what a unit test cannot: that the catalog route is
 * MOUNTED and answers off the app's own registry + workspace rows, and that a cleared pin left the
 * STORE rather than merely the response.
 */
function defineCustomProvisioningPins(harness: ConformanceHarness): void {
  describe('public API: custom provisioning pins', () => {
    it('publishes what a pin may name, and still accepts a pin naming something else', async () => {
      // Both halves of the same fact. Nothing validates a `manifestId` on the way in: it is checked
      // as a string and matched to a handler only when a run reaches its `deployer` step, so an id
      // no handler serves is stored and reported back as configured. Refusing it at the write would
      // narrow what a live integration may send (ADR 0034), so the catalog is what lets a caller
      // refuse BEFORE it pays for a run, and the accepted-anyway pin is the behaviour that makes
      // the catalog load-bearing rather than decorative.
      const registries = createBackendRegistries()
      registries.customManifestTypeRegistry.register({
        manifestId: 'conformance-kargo',
        label: 'Conformance Kargo',
        defaultManifestPath: 'deploy/preview.yaml',
      })
      const app = harness.makeApp(undefined, { backendRegistries: registries })
      const { workspace } = await app.createOrgWorkspace()
      const admin = await mintPublicApiKey(app, workspace.id, 'admin', 'pins')

      const catalog = await app.call<{
        manifestTypes: {
          manifestId: string
          label: string
          source: string
          defaultManifestPath: string | null
        }[]
      }>('GET', '/api/v1/environments/manifest-types', undefined, admin)
      expect(catalog.status).toBe(200)
      const registered = catalog.body.manifestTypes.find(
        (type) => type.manifestId === 'conformance-kargo',
      )
      // `registered` and not `workspace`: an id missing from a code-registered catalog is a
      // deployment change, where a missing row is an edit in the app, and those are different
      // people. The default path is what a pin naming no `manifestPath` will deploy from.
      expect(registered).toEqual({
        manifestId: 'conformance-kargo',
        label: 'Conformance Kargo',
        source: 'registered',
        defaultManifestPath: 'deploy/preview.yaml',
      })

      const service = await app.call<{ serviceId: string }>(
        'POST',
        '/api/v1/services',
        { title: 'Pinned' },
        admin,
      )
      const unserved = await app.call<{ provisioning?: { type: string; manifestId?: string } }>(
        'PATCH',
        `/api/v1/services/${service.body.serviceId}`,
        { provisioning: { type: 'custom', manifestId: 'served-by-nobody' } },
        admin,
      )
      expect(unserved.status).toBe(200)
      expect(unserved.body.provisioning).toEqual({ type: 'custom', manifestId: 'served-by-nobody' })
      expect(catalog.body.manifestTypes.map((type) => type.manifestId)).not.toContain(
        'served-by-nobody',
      )
    })

    it('CLEARS a pin on an explicit null, and leaves an omitted one alone', async () => {
      // The pair, in the order a caller hits it. A suite that pins a shared board's frame had no
      // way to undo the write, because the provisioning variant has two members and neither means
      // "none"; and the omission must keep meaning "leave it alone", or a caller correcting a
      // title would un-deploy the service.
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const admin = await mintPublicApiKey(app, workspace.id, 'admin', 'pins')
      const service = await app.call<{ serviceId: string }>(
        'POST',
        '/api/v1/services',
        { title: 'Pinned then cleared' },
        admin,
      )
      const serviceId = service.body.serviceId
      await app.call(
        'PATCH',
        `/api/v1/services/${serviceId}`,
        { provisioning: { type: 'custom', manifestId: 'conformance-kargo' } },
        admin,
      )

      const renamed = await app.call<{ title: string; provisioning?: { manifestId?: string } }>(
        'PATCH',
        `/api/v1/services/${serviceId}`,
        { title: 'Renamed, still deploying' },
        admin,
      )
      expect(renamed.body.provisioning?.manifestId).toBe('conformance-kargo')

      const cleared = await app.call<{ provisioning?: unknown }>(
        'PATCH',
        `/api/v1/services/${serviceId}`,
        { provisioning: null },
        admin,
      )
      expect(cleared.status).toBe(200)
      expect('provisioning' in cleared.body).toBe(false)
      // Off the STORE, not just off the response the write happened to build: this is the half a
      // unit test cannot see, and the one a facade that lowered the clear differently would fail.
      const reread = await app.call<{ services: { serviceId: string; provisioning?: unknown }[] }>(
        'GET',
        '/api/v1/services',
        undefined,
        admin,
      )
      const stored = reread.body.services.find((entry) => entry.serviceId === serviceId)
      expect(stored).toBeDefined()
      expect('provisioning' in (stored ?? {})).toBe(false)
    })
  })
}

/** Raising a service, filing work under it, and taking it back down. */
function defineServiceProvisioning(harness: ConformanceHarness): void {
  describe('public API: board provisioning', () => {
    it('creates a service headlessly and files a task under it', async () => {
      // The gap this closes: `/api/v1` could list services and file work under one, and nothing
      // could CREATE one. A deployment that provisions its own keys and enrols its own webhook
      // still had to open the app once, to have anywhere to file work at all.
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const wsId = workspace.id
      const admin = await mintPublicApiKey(app, wsId, 'admin', 'board')

      const created = await app.call<{ serviceId: string; title: string; type: string }>(
        'POST',
        '/api/v1/services',
        { title: 'Payments API', description: 'Money in, money out.', type: 'service' },
        admin,
      )
      expect(created.status).toBe(201)
      expect(created.body.title).toBe('Payments API')
      expect(created.body.type).toBe('service')

      // It is a REAL board service, not a projection that exists only in the create response:
      // the list every other caller reads must show it, and a task must be fileable under it.
      const listed = await app.call<{ services: { serviceId: string }[] }>(
        'GET',
        '/api/v1/services',
        undefined,
        admin,
      )
      expect(listed.body.services.map((s) => s.serviceId)).toContain(created.body.serviceId)
      const task = await app.call<PublicTask>(
        'POST',
        `/api/v1/services/${created.body.serviceId}/tasks`,
        { title: 'Add a health check' },
        admin,
      )
      expect(task.status).toBe(201)
      expect(task.body.serviceId).toBe(created.body.serviceId)
    })

    it('deletes a service once its work is gone, and refuses one still holding unfinished tasks', async () => {
      // The inverse of the create, and the last board write with no headless door: a key
      // authenticates on `/api/v1` alone, so a caller that raised a service had to ask a person to
      // take it down. What only a facade run can show is that each one MOUNTS the route and that the
      // frame really leaves its OWN store, rather than the response merely saying so.
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const admin = await mintPublicApiKey(app, workspace.id, 'admin', 'board')
      const service = await app.call<{ serviceId: string }>(
        'POST',
        '/api/v1/services',
        { title: 'Reclaimable' },
        admin,
      )
      const serviceId = service.body.serviceId
      const task = await app.call<PublicTask>(
        'POST',
        `/api/v1/services/${serviceId}/tasks`,
        { title: 'Work in flight' },
        admin,
      )
      // A run under that task, seeded through the facade's own store because the work this
      // refusal protects is not the block, it is the HISTORY: the delete path tears every run
      // under the subtree down (container, durable driver, row) before it removes anything, so a
      // guard that fired one step later would answer 422 about a board it had already emptied.
      await app.executionRepository().upsert(workspace.id, {
        id: 'exec_in_flight',
        blockId: task.body.taskId,
        pipelineId: 'pl_simple',
        pipelineName: 'Simple build',
        steps: [{ agentKind: 'coder', state: 'working', progress: 0, decision: null }],
        currentStep: 0,
        status: 'running',
        initiatedBy: null,
      })

      // The guard, and the reason it is a REFUSAL rather than a cascade: deleting the frame would
      // discard that task and its history with no way back. The `reason` is what a headless caller
      // branches on, so it is asserted rather than the prose beside it.
      const refused = await app.call<{ error: { details?: { reason?: string } } }>(
        'DELETE',
        `/api/v1/services/${serviceId}`,
        undefined,
        admin,
      )
      expect(refused.status).toBe(422)
      expect(refused.body.error.details?.reason).toBe('service_has_unfinished_tasks')
      // Nothing happened: the refusal is not a partial delete that took the tasks with it, and
      // the run it named is still there to be resumed or stopped on purpose.
      expect(
        (await app.call('GET', `/api/v1/tasks/${task.body.taskId}`, undefined, admin)).status,
      ).toBe(200)
      expect(await app.executionRepository().get(workspace.id, 'exec_in_flight')).not.toBeNull()

      // The caller that means it clears the work first. That pair IS the reclaim sequence a headless
      // setup runs, which is why both halves are driven here rather than asserted separately.
      expect(
        (await app.call('DELETE', `/api/v1/tasks/${task.body.taskId}`, undefined, admin)).status,
      ).toBe(204)
      // …and THAT is where the history goes: the same teardown, run by the call that meant it.
      expect(await app.executionRepository().get(workspace.id, 'exec_in_flight')).toBeNull()
      const deleted = await app.call('DELETE', `/api/v1/services/${serviceId}`, undefined, admin)
      expect(deleted.status).toBe(204)

      // Gone from the store, not just from the response: the list every other caller reads, and the
      // frame's own point read (which is also what makes a second delete a 404 rather than a 204).
      const listed = await app.call<{ services: { serviceId: string }[] }>(
        'GET',
        '/api/v1/services',
        undefined,
        admin,
      )
      expect(listed.body.services.map((entry) => entry.serviceId)).not.toContain(serviceId)
      expect(
        (await app.call('DELETE', `/api/v1/services/${serviceId}`, undefined, admin)).status,
      ).toBe(404)
    })

    it('lists repositories rather than refusing when the workspace has connected none', async () => {
      // Discovery, and the degrade rule: "you have connected no repositories" and "this deployment
      // has no VCS integration" are the same instruction to a caller (connect one), so the read
      // answers an empty list. It is the CREATE that distinguishes them, by refusing with a reason.
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const read = await mintPublicApiKey(app, workspace.id, 'read', 'board')
      const repos = await app.call<PublicRepoList>('GET', '/api/v1/repos', undefined, read)
      expect(repos.status).toBe(200)
      expect(repos.body.repos).toEqual([])
    })

    it('refuses a repository this workspace does not have, rather than creating an empty frame', async () => {
      // A service frame with no linked repository cannot run anything, so a create that silently
      // dropped an unresolvable `repo` would hand a caller a service its own tasks refuse to start
      // on, with nothing at creation time saying why.
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const admin = await mintPublicApiKey(app, workspace.id, 'admin', 'board')
      const refused = await app.call(
        'POST',
        '/api/v1/services',
        { title: 'Ghost', repo: { repoId: 999_999 } },
        admin,
      )
      expect([404, 422]).toContain(refused.status)
    })

    it('is ADMIN scope: a write key cannot create board structure', async () => {
      // The rung these endpoints sit on, asserted rather than merely documented. `write` is what a
      // ticket-filing integration holds, and creating or removing services is board STRUCTURE.
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const write = await mintPublicApiKey(app, workspace.id, 'write', 'board')
      const refused = await app.call('POST', '/api/v1/services', { title: 'Nope' }, write)
      expect(refused.status).toBe(403)
      // The delete is refused at the same rung and BEFORE the frame is resolved, which is why a
      // made-up id still answers 403 rather than 404: a scope refusal that leaked existence would
      // let a `write` key enumerate the board's frames.
      expect((await app.call('DELETE', '/api/v1/services/blk_nope', undefined, write)).status).toBe(
        403,
      )
      // The discovery read is the floor, so the same key still sees what it could create against.
      expect((await app.call('GET', '/api/v1/repos', undefined, write)).status).toBe(200)
      // The ADOPT pair (`/repos/available` + `/repos/link`, what makes headless setup finishable
      // now that linking is no longer app-only) sits at `admin` on BOTH halves, including the read:
      // it names what the deployment's own credential can reach, which is operator-facing, and a key
      // that can enumerate it is at the rung that could adopt one.
      //
      // These two `403`s are also this lane's MOUNT check, and deliberately the whole of it. The
      // scope gate runs inside the route, so an unregistered path answers `404` instead and this
      // fails; and it runs BEFORE the module lookup, so it is the only assertion here that cannot
      // reach the provider. An `admin` call would: on a facade whose connect path is a personal
      // token, the picker enumerates the provider LIVE, so asserting the happy path would put a
      // network call (and someone else's rate limit) inside a conformance run. What that call
      // ANSWERS is covered where it belongs, in `GitHubSyncService.linkRepoBySlug`'s own tests and in
      // the acceptance suite against a live deployment.
      expect((await app.call('GET', '/api/v1/repos/available', undefined, write)).status).toBe(403)
      expect(
        (await app.call('POST', '/api/v1/repos/link', { owner: 'a', name: 'b' }, write)).status,
      ).toBe(403)
    })
  })
}

/** The ordering edges between two tasks, which converge rather than toggle. */
function defineTaskDependencies(harness: ConformanceHarness): void {
  describe('public API: task dependencies', () => {
    it('declares an ordering, reads it back, and converges on a repeat', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const wsId = workspace.id
      const admin = await mintPublicApiKey(app, wsId, 'admin', 'board')
      const service = await app.call<{ serviceId: string }>(
        'POST',
        '/api/v1/services',
        { title: 'Ordered work' },
        admin,
      )
      const file = async (title: string) =>
        (
          await app.call<PublicTask>(
            'POST',
            `/api/v1/services/${service.body.serviceId}/tasks`,
            { title },
            admin,
          )
        ).body.taskId
      const api = await file('Ship the API')
      const ui = await file('Ship the UI')

      const linked = await app.call<PublicTask>(
        'POST',
        `/api/v1/tasks/${ui}/dependencies`,
        { dependsOnTaskId: api },
        admin,
      )
      expect(linked.status).toBe(200)
      expect(linked.body.dependsOn).toEqual([api])

      // IDEMPOTENT, which is the whole reason this is not the board's own toggle: a provisioning
      // integration re-running its own setup must converge. A toggle would drop the edge here,
      // silently, since the call succeeds either way and the graph it asked for is the one it does
      // not get.
      const again = await app.call<PublicTask>(
        'POST',
        `/api/v1/tasks/${ui}/dependencies`,
        { dependsOnTaskId: api },
        admin,
      )
      expect(again.body.dependsOn).toEqual([api])
      // …and the read every other caller uses says the same.
      const read = await app.call<PublicTask>('GET', `/api/v1/tasks/${ui}`, undefined, admin)
      expect(read.body.dependsOn).toEqual([api])

      // A cycle would wedge the engine's start gate and the auto-start against each other forever.
      const cycle = await app.call(
        'POST',
        `/api/v1/tasks/${api}/dependencies`,
        { dependsOnTaskId: ui },
        admin,
      )
      expect(cycle.status).toBe(422)

      const removed = await app.call<PublicTask>(
        'POST',
        `/api/v1/tasks/${ui}/dependencies/remove`,
        { dependsOnTaskId: api },
        admin,
      )
      expect(removed.body.dependsOn).toEqual([])
      // Removing an edge that is not there converges too, for the same reason.
      const removedAgain = await app.call<PublicTask>(
        'POST',
        `/api/v1/tasks/${ui}/dependencies/remove`,
        { dependsOnTaskId: api },
        admin,
      )
      expect(removedAgain.status).toBe(200)
      expect(removedAgain.body.dependsOn).toEqual([])
    })

    it('names WHICH id was wrong, and toggles auto-start on the blocker', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const admin = await mintPublicApiKey(app, workspace.id, 'admin', 'board')
      const service = await app.call<{ serviceId: string }>(
        'POST',
        '/api/v1/services',
        { title: 'Ordering refusals' },
        admin,
      )
      const task = await app.call<PublicTask>(
        'POST',
        `/api/v1/services/${service.body.serviceId}/tasks`,
        { title: 'Only task' },
        admin,
      )
      const taskId = task.body.taskId

      // A caller that transposed two ids must not be left comparing two identical refusals.
      const unknownBlocker = await app.call<{ error: { details?: { reason?: string } } }>(
        'POST',
        `/api/v1/tasks/${taskId}/dependencies`,
        { dependsOnTaskId: 'blk_nope' },
        admin,
      )
      expect(unknownBlocker.status).toBe(404)
      expect(unknownBlocker.body.error.details?.reason).toBe('depends_on_task_not_found')
      const unknownTask = await app.call<{ error: { details?: { reason?: string } } }>(
        'POST',
        '/api/v1/tasks/blk_nope/dependencies',
        { dependsOnTaskId: taskId },
        admin,
      )
      expect(unknownTask.status).toBe(404)
      expect(unknownTask.body.error.details?.reason).toBe('task_not_found')

      // The other half of an ordering: `autoStartDependents` is what makes a declared chain run
      // itself once the blocker's pull request merges.
      expect(task.body.autoStartDependents).toBe(false)
      const patched = await app.call<PublicTask>(
        'PATCH',
        `/api/v1/tasks/${taskId}`,
        { autoStartDependents: true },
        admin,
      )
      expect(patched.body.autoStartDependents).toBe(true)
      const reread = await app.call<PublicTask>('GET', `/api/v1/tasks/${taskId}`, undefined, admin)
      expect(reread.body.autoStartDependents).toBe(true)
    })
  })
}

/** Specs attached to a task that already exists. */
function defineTaskDocuments(harness: ConformanceHarness): void {
  describe('public API: a task’s documents after it exists', () => {
    it('attaches, lists and detaches a spec that arrived after the task', async () => {
      // Before this, editing a task's corpus headlessly meant deleting the task and filing it
      // again, which loses the id every stored reference points at, its ticket claim and the
      // documents it already carried.
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const admin = await mintPublicApiKey(app, workspace.id, 'admin', 'board')
      const service = await app.call<{ serviceId: string }>(
        'POST',
        '/api/v1/services',
        { title: 'Specified work' },
        admin,
      )
      const task = await app.call<PublicTask>(
        'POST',
        `/api/v1/services/${service.body.serviceId}/tasks`,
        { title: 'Split payments at checkout' },
        admin,
      )
      const taskId = task.body.taskId
      const documents = `/api/v1/tasks/${taskId}/documents`

      expect(
        (await app.call<PublicAttachedDocumentList>('GET', documents, undefined, admin)).body
          .documents,
      ).toEqual([])

      const attached = await app.call<{ source: string; externalId: string; title: string }>(
        'POST',
        documents,
        {
          document: {
            kind: 'upload',
            title: 'Checkout PRD',
            content: '# Checkout PRD\n\n## Goal\nSplit the payment across two methods.',
          },
        },
        admin,
      )
      expect(attached.status).toBe(201)
      expect(attached.body.source).toBe('upload')
      expect(attached.body.title).toBe('Checkout PRD')
      // The response carries the id the PLATFORM minted, not an echo of what was sent: it is the
      // value a later detach has to name, and an upload has none until it is stored.
      expect(attached.body.externalId.length).toBeGreaterThan(0)

      const listed = await app.call<PublicAttachedDocumentList>('GET', documents, undefined, admin)
      expect(listed.body.documents.map((d) => d.externalId)).toEqual([attached.body.externalId])
      // An upload has no page behind it, so it has no URL: an empty string rather than a link that
      // resolves to nothing.
      expect(listed.body.documents[0]?.url).toBe('')

      const detached = await app.call(
        'POST',
        `${documents}/detach`,
        { source: attached.body.source, externalId: attached.body.externalId },
        admin,
      )
      expect(detached.status).toBe(204)
      expect(
        (await app.call<PublicAttachedDocumentList>('GET', documents, undefined, admin)).body
          .documents,
      ).toEqual([])
      // Idempotent: a caller retrying after a timeout should converge rather than have to tell
      // "it was never attached" from "I already detached it".
      expect(
        (
          await app.call(
            'POST',
            `${documents}/detach`,
            { source: attached.body.source, externalId: attached.body.externalId },
            admin,
          )
        ).status,
      ).toBe(204)
    })

    it('404s the document routes for a task this key cannot reach', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const { workspace: other } = await app.createOrgWorkspace()
      const admin = await mintPublicApiKey(app, workspace.id, 'admin', 'board')
      const service = await app.call<{ serviceId: string }>(
        'POST',
        '/api/v1/services',
        { title: 'Elsewhere' },
        await mintPublicApiKey(app, other.id, 'admin', 'board'),
      )
      const foreign = await app.call<PublicTask>(
        'POST',
        `/api/v1/services/${service.body.serviceId}/tasks`,
        { title: "Someone else's task" },
        await mintPublicApiKey(app, other.id, 'admin', 'board'),
      )
      // The key's workspace is the boundary on every one of these routes, exactly as it is on the
      // task lifecycle they hang off.
      const read = await app.call(
        'GET',
        `/api/v1/tasks/${foreign.body.taskId}/documents`,
        undefined,
        admin,
      )
      expect(read.status).toBe(404)
    })
  })
}
