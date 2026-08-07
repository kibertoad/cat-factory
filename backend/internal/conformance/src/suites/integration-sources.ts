import { resolveDocTemplate } from '@cat-factory/agents'
import type {
  AgentFailure,
  Block,
  DocumentRecord,
  SourceTask,
  TaskRecord,
  TaskSourceDiagnostic,
  TaskSourceState,
  WorkspaceSnapshot,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { FakeTaskSourceProvider } from '../FakeTaskSourceProvider.js'
import type { ConformanceHarness } from '../harness.js'

export function defineSourcesConformance(harness: ConformanceHarness): void {
  describe('repo bootstrap', () => {
    it('round-trips reference architectures', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const base = `/workspaces/${workspace.id}/bootstrap/reference-architectures`

      const empty = await call<unknown[]>('GET', base)
      expect(empty.status).toBe(200)
      expect(empty.body).toEqual([])

      const created = await call<{ id: string; name: string }>('POST', base, {
        name: 'Node service',
        repoOwner: 'acme',
        repoName: 'reference-node',
        defaultInstructions: 'Adapt the reference service.',
      })
      expect(created.status).toBe(201)
      expect(created.body.name).toBe('Node service')

      const renamed = await call<{ name: string }>('PATCH', `${base}/${created.body.id}`, {
        name: 'Node service v2',
      })
      expect(renamed.status).toBe(200)
      expect(renamed.body.name).toBe('Node service v2')

      const listed = await call<{ id: string }[]>('GET', base)
      expect(listed.body.map((r) => r.id)).toEqual([created.body.id])

      const del = await call('DELETE', `${base}/${created.body.id}`)
      expect(del.status).toBe(204)
      expect((await call<unknown[]>('GET', base)).body).toEqual([])
    })

    it('drives a bootstrap run to success and materialises its service frame', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      // Kick off a from-scratch bootstrap (the FakeRepoBootstrapper reports connected,
      // so the pre-flight passes). The call returns immediately with a running job that
      // already carries its provisional service frame.
      const started = await app.call<{ id: string; status: string; blockId: string | null }>(
        'POST',
        `/workspaces/${wsId}/bootstrap/jobs`,
        { repoName: 'new-service', instructions: 'Scaffold a small HTTP service.' },
      )
      expect(started.status).toBe(201)
      expect(started.body.status).toBe('running')
      expect(started.body.blockId).toBeTruthy()
      const jobId = started.body.id
      const frameId = started.body.blockId!

      // Drive the durable poll loop (production: pg-boss / a BootstrapWorkflow). The
      // default fake reports `done` on the first poll.
      const polls = await app.driveBootstrap(wsId, jobId)
      expect(polls).toBeGreaterThanOrEqual(1)

      // The job is now succeeded and its service frame is materialised on the board
      // (a real frame, not blocked — the success path flips it ready, after which the
      // best-effort initial blueprint run may move it to in_progress; both are success
      // states and identical across facades, so we assert it isn't the failure state).
      const job = await app.call<{ status: string; blockId: string | null }>(
        'GET',
        `/workspaces/${wsId}/bootstrap/jobs/${jobId}`,
      )
      expect(job.body.status).toBe('succeeded')

      const snap = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      const frame = snap.body.blocks.find((b) => b.id === frameId)
      expect(frame?.level).toBe('frame')
      expect(frame?.status).not.toBe('blocked')

      // The frame's own transitions (materialised, then ready) reach the board as coarse events
      // NAMING it, never as a payload: a frame's position and size are a per-board mount override,
      // so the one payload published for every board mounting the service would be wrong on all
      // but one of them. Each board re-reads its own projection instead. The progress ticks in
      // between ride the `bootstrap` event alone and cost no refresh at all, which is the whole
      // reason the two are split.
      const frameSignals = app.boardEmits(frameId)
      expect(frameSignals.length).toBeGreaterThan(0)
      expect(frameSignals.every((e) => !e.hasBlock)).toBe(true)
      expect(frameSignals.some((e) => e.reason === 'bootstrap-succeeded')).toBe(true)
    })

    it('reads a stopped run’s structured failure back off the store', async () => {
      // The bootstrap repositories decode `agent_runs.failure` through the shared,
      // FULL-schema `parseStoredAgentFailure`, which drops any record the wire contract
      // wouldn't accept. So a drift between what `BootstrapService.buildFailure` WRITES and
      // what `agentFailureSchema` requires (a new required field, a renamed one) costs every
      // bootstrap failure its diagnostics SILENTLY — the board showing a stopped run with no
      // reason to retry from — rather than failing loudly. Driving a real stop and re-reading
      // pins that write↔read pair on D1 and Postgres alike.
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      const started = await app.call<{ id: string }>('POST', `/workspaces/${wsId}/bootstrap/jobs`, {
        repoName: 'stopped-service',
        instructions: 'Scaffold a small HTTP service.',
      })
      expect(started.status).toBe(201)
      const jobId = started.body.id

      const stopped = await app.call('POST', `/workspaces/${wsId}/agent-runs/${jobId}/stop`)
      expect(stopped.status).toBe(200)

      // Re-READ off the store: the stop response is the service's own in-memory patch, so
      // only a fresh GET exercises the repository's decode.
      const reread = await app.call<{ status: string; failure: AgentFailure | null }>(
        'GET',
        `/workspaces/${wsId}/bootstrap/jobs/${jobId}`,
      )
      expect(reread.body.status).toBe('failed')
      expect(reread.body.failure).toBeTruthy()
      expect(reread.body.failure?.kind).toBe('cancelled')
      // The fields the full-schema decode requires — a record missing any one of them would
      // have been dropped above, so naming them documents what "survived" has to mean.
      expect(typeof reread.body.failure?.hint).toBe('string')
      expect(typeof reread.body.failure?.occurredAt).toBe('number')
    })
  })

  registerTaskSourceTests(harness)
  registerDocumentSourceTests(harness)
  registerDocumentPersistenceTests(harness)
  registerDocumentFreshnessTests(harness)
}

/**
 * Task sources: connect / toggle / import, filing a board task from an imported issue (and the
 * one-task-per-ticket refusal, plus the re-file a deleted task allows), and the custom-source
 * id vocabulary.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerTaskSourceTests(harness: ConformanceHarness): void {
  describe('task sources', () => {
    it('creates a board task from an imported issue and links the issue to it', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace({ seed: false })
      const ws = workspace.id

      // A service frame to create the task inside.
      const frame = await call<Block>('POST', `/workspaces/${ws}/blocks`, {
        type: 'service',
        position: { x: 0, y: 0 },
      })
      expect(frame.status).toBe(201)

      // Connect + import the issue (the fake provider accepts any credentials and
      // generates a deterministic issue), then materialise it as a board task.
      await call('POST', `/workspaces/${ws}/task-sources/jira/connect`, {
        credentials: {
          baseUrl: 'https://acme.atlassian.net',
          accountEmail: 'd@a.io',
          apiToken: 't',
        },
      })
      await call('POST', `/workspaces/${ws}/task-sources/jira/import`, { ref: 'PROJ-42' })

      const created = await call<{ block: Block; task: SourceTask }>(
        'POST',
        `/workspaces/${ws}/tasks/create-block`,
        { source: 'jira', externalId: 'PROJ-42', containerId: frame.body.id },
      )
      expect(created.status).toBe(201)

      // The new block is a leaf task under the frame, seeded from the issue.
      const block = created.body.block
      expect(block.level).toBe('task')
      expect(block.parentId).toBe(frame.body.id)
      expect(block.title).toContain('PROJ-42')
      expect(block.description).toContain('Description for PROJ-42')
      expect(block.status).toBe('planned')

      // The issue is linked to the new task for context, and it's persisted: the
      // board snapshot includes it and the issue list reflects the link.
      expect(created.body.task.linkedBlockId).toBe(block.id)
      const snapshot = await call<WorkspaceSnapshot>('GET', `/workspaces/${ws}`)
      expect(snapshot.body.blocks.some((b) => b.id === block.id && b.level === 'task')).toBe(true)
      const issues = await call<SourceTask[]>('GET', `/workspaces/${ws}/tasks`)
      expect(issues.body.find((t) => t.externalId === 'PROJ-42')?.linkedBlockId).toBe(block.id)

      // Creating a second task from the already-linked issue is refused (409), so the
      // single issue→block link is never silently re-pointed away from the first task.
      const again = await call('POST', `/workspaces/${ws}/tasks/create-block`, {
        source: 'jira',
        externalId: 'PROJ-42',
        containerId: frame.body.id,
      })
      expect(again.status).toBe(409)
    })

    it('re-files an issue whose task was deleted, instead of refusing forever', async () => {
      // The delete cascade's whole point, end to end. `linked_block_id` is what three readers
      // consult to decide an issue is spoken for, and none of them checks whether the block it
      // names still exists, so before the cascade detached issues, deleting a filed task took
      // its ticket out of circulation permanently: invisible to the intake sweep, and refused by
      // `claimBlockLink` on every future filing, naming a task nobody could open.
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace({ seed: false })
      const ws = workspace.id

      const frame = await call<Block>('POST', `/workspaces/${ws}/blocks`, {
        type: 'service',
        position: { x: 0, y: 0 },
      })
      await call('POST', `/workspaces/${ws}/task-sources/jira/connect`, {
        credentials: {
          baseUrl: 'https://acme.atlassian.net',
          accountEmail: 'd@a.io',
          apiToken: 't',
        },
      })
      await call('POST', `/workspaces/${ws}/task-sources/jira/import`, { ref: 'PROJ-77' })

      const filed = await call<{ block: Block; task: SourceTask }>(
        'POST',
        `/workspaces/${ws}/tasks/create-block`,
        { source: 'jira', externalId: 'PROJ-77', containerId: frame.body.id },
      )
      expect(filed.status).toBe(201)

      const removed = await call('DELETE', `/workspaces/${ws}/blocks/${filed.body.block.id}`)
      expect(removed.status).toBe(204)

      // The link went with the block, so the issue is unclaimed again, asserted off the store
      // rather than inferred from the re-file succeeding.
      const issues = await call<SourceTask[]>('GET', `/workspaces/${ws}/tasks`)
      expect(issues.body.find((t) => t.externalId === 'PROJ-77')?.linkedBlockId).toBeNull()

      // And the issue itself survived the delete: nothing was removed, only unlinked.
      expect(issues.body.some((t) => t.externalId === 'PROJ-77')).toBe(true)

      const refiled = await call<{ block: Block; task: SourceTask }>(
        'POST',
        `/workspaces/${ws}/tasks/create-block`,
        { source: 'jira', externalId: 'PROJ-77', containerId: frame.body.id },
      )
      expect(refiled.status).toBe(201)
      expect(refiled.body.task.linkedBlockId).toBe(refiled.body.block.id)
      expect(refiled.body.block.id).not.toBe(filed.body.block.id)
    })

    it('404s when the issue was never imported', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace({ seed: false })
      const ws = workspace.id
      const frame = await call<Block>('POST', `/workspaces/${ws}/blocks`, {
        type: 'service',
        position: { x: 0, y: 0 },
      })

      const res = await call('POST', `/workspaces/${ws}/tasks/create-block`, {
        source: 'jira',
        externalId: 'PROJ-999',
        containerId: frame.body.id,
      })
      expect(res.status).toBe(404)
    })

    it('toggles a source off per workspace, gating import, and persists the toggle', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace({ seed: false })
      const ws = workspace.id

      // A connected source starts available + enabled (offered).
      await call('POST', `/workspaces/${ws}/task-sources/jira/connect`, {
        credentials: {
          baseUrl: 'https://acme.atlassian.net',
          accountEmail: 'd@a.io',
          apiToken: 't',
        },
      })
      const before = await call<{ sources: TaskSourceState[] }>(
        'GET',
        `/workspaces/${ws}/task-sources`,
      )
      const jiraBefore = before.body.sources.find((s) => s.source === 'jira')
      expect(jiraBefore?.available).toBe(true)
      expect(jiraBefore?.enabled).toBe(true)

      // Disabling it is refused-from-use and reflected on the source state (persisted).
      const off = await call('PUT', `/workspaces/${ws}/task-sources/jira/enabled`, {
        enabled: false,
      })
      expect(off.status).toBe(204)
      const after = await call<{ sources: TaskSourceState[] }>(
        'GET',
        `/workspaces/${ws}/task-sources`,
      )
      expect(after.body.sources.find((s) => s.source === 'jira')?.enabled).toBe(false)
      const blocked = await call('POST', `/workspaces/${ws}/task-sources/jira/import`, {
        ref: 'PROJ-7',
      })
      expect(blocked.status).toBe(409)

      // Re-enabling restores import.
      await call('PUT', `/workspaces/${ws}/task-sources/jira/enabled`, { enabled: true })
      const ok = await call('POST', `/workspaces/${ws}/task-sources/jira/import`, {
        ref: 'PROJ-7',
      })
      expect(ok.status).toBe(201)
    })

    it('runs a live setup-check, gating on connection then delegating to the provider', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace({ seed: false })
      const ws = workspace.id

      // A credentialed source with no connection yet reports `not_connected` —
      // the service gates on availability before it would ever probe.
      const before = await call<TaskSourceDiagnostic>(
        'POST',
        `/workspaces/${ws}/task-sources/jira/diagnostics`,
      )
      expect(before.status).toBe(200)
      expect(before.body.ok).toBe(false)
      expect(before.body.status).toBe('not_connected')

      // Once connected, the check delegates to the provider's live probe (the fake
      // returns a ready verdict), so a configured source reports ready.
      await call('POST', `/workspaces/${ws}/task-sources/jira/connect`, {
        credentials: {
          baseUrl: 'https://acme.atlassian.net',
          accountEmail: 'd@a.io',
          apiToken: 't',
        },
      })
      const after = await call<TaskSourceDiagnostic>(
        'POST',
        `/workspaces/${ws}/task-sources/jira/diagnostics`,
      )
      expect(after.status).toBe(200)
      expect(after.body.ok).toBe(true)
      expect(after.body.status).toBe('ready')
    })

    it('wires Linear as a task source on every facade (registered, connect, import-gated)', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace({ seed: false })
      const ws = workspace.id

      // Linear is registered symmetrically across runtimes: it shows up in the source
      // list (so the connect UI offers it), connects with a personal API key, and lists
      // back available + enabled — the same lifecycle as Jira, proving the wiring.
      const listed = await call<{ sources: TaskSourceState[] }>(
        'GET',
        `/workspaces/${ws}/task-sources`,
      )
      expect(listed.body.sources.some((s) => s.source === 'linear')).toBe(true)

      const connected = await call<{ source: string }>(
        'POST',
        `/workspaces/${ws}/task-sources/linear/connect`,
        { credentials: { apiKey: 'lin_api_secret_key_123' } },
      )
      expect(connected.status).toBe(201)
      expect(JSON.stringify(connected.body)).not.toContain('lin_api_secret_key_123')

      const after = await call<{ sources: TaskSourceState[] }>(
        'GET',
        `/workspaces/${ws}/task-sources`,
      )
      const linear = after.body.sources.find((s) => s.source === 'linear')
      expect(linear?.available).toBe(true)
      expect(linear?.enabled).toBe(true)
    })

    it('wires the Linear OAuth + team-picker routes on every facade', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace({ seed: false })
      const ws = workspace.id

      // The descriptor advertises the OAuth connect option (the SPA shows the
      // "Connect with Linear" button), in addition to the manual API-key field.
      const listed = await call<{ sources: TaskSourceState[] }>(
        'GET',
        `/workspaces/${ws}/task-sources`,
      )
      const linear = listed.body.sources.find((s) => s.source === 'linear')
      expect(linear?.oauth).toBe(true)

      // The install-url route is wired but reports 503 until the deployment configures
      // a Linear OAuth app (the conformance harness leaves it unconfigured).
      const installUrl = await call('GET', `/workspaces/${ws}/task-sources/linear/install-url`)
      expect(installUrl.status).toBe(503)

      // The team-picker route is wired; with no Linear connection it refuses (409)
      // rather than 404 — proving the route exists symmetrically on both runtimes.
      const teams = await call('GET', `/workspaces/${ws}/task-sources/linear/teams`)
      expect(teams.status).toBe(409)
    })

    it('serves a DEPLOYMENT-REGISTERED task source through the same lifecycle', async () => {
      // Slice 4 of `backend/docs/adr/0032-tracker-webhook-intake.md`: the source vocabulary is
      // `builtin picklist ∪ <ns>:<name>`, so a deployment registers a fourth tracker in CODE on
      // the app-owned `TaskSourceRegistry` and it is served by every surface that reads the
      // registry rather than a hard-coded list. Registered here exactly as a deployment would:
      // one more provider in the container's `taskSourceProviders`.
      const source = new FakeTaskSourceProvider('acme:servicenow')
      source.set('INC-7', { title: 'Checkout returns 500', labels: ['bug'] })
      const { call, createWorkspace } = harness.makeApp({}, { taskSourceProviders: [source] })
      const { workspace } = await createWorkspace({ seed: false })
      const ws = workspace.id

      const listed = await call<{ sources: TaskSourceState[] }>(
        'GET',
        `/workspaces/${ws}/task-sources`,
      )
      expect(listed.body.sources.some((s) => s.source === 'acme:servicenow')).toBe(true)

      const connected = await call(
        'POST',
        `/workspaces/${ws}/task-sources/acme:servicenow/connect`,
        {
          credentials: { token: 'sn_secret_token_123' },
        },
      )
      expect(connected.status).toBe(201)
      expect(JSON.stringify(connected.body)).not.toContain('sn_secret_token_123')

      // Importing through a registered source projects a row keyed by the namespaced kind, so
      // persistence carries it verbatim — the widening added no encoding of its own.
      const imported = await call<SourceTask>(
        'POST',
        `/workspaces/${ws}/task-sources/acme:servicenow/import`,
        { ref: 'INC-7' },
      )
      expect(imported.status).toBe(201)
      expect(imported.body.source).toBe('acme:servicenow')
      expect(imported.body.title).toBe('Checkout returns 500')

      // Read back off the projection: the namespaced kind round-trips through the persisted
      // `source` column unchanged on every runtime, which is the whole claim that widening the
      // vocabulary needed no migration.
      const projected = await call<SourceTask[]>('GET', `/workspaces/${ws}/tasks`)
      expect(projected.status).toBe(200)
      const row = projected.body.find((t) => t.externalId === 'INC-7')
      expect(row?.source).toBe('acme:servicenow')
    })

    it('tells a MALFORMED source id apart from an unregistered one', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace({ seed: false })
      const ws = workspace.id

      // A bare non-built-in id is a TYPO and fails the grammar — this is what keeps widening the
      // vocabulary from turning every misspelled segment into a plausible-looking miss.
      const malformed = await call('POST', `/workspaces/${ws}/task-sources/servicenow/import`, {
        ref: 'INC-7',
      })
      expect(malformed.status).toBe(422)

      // A WELL-FORMED id nothing registered is a different failure with a different fix, and it is
      // refused by the registry rather than by the schema.
      const unregistered = await call(
        'POST',
        `/workspaces/${ws}/task-sources/acme:servicenow/connect`,
        { credentials: { token: 't' } },
      )
      expect(unregistered.status).toBe(422)
      expect(JSON.stringify(unregistered.body)).toContain('acme:servicenow')
    })
  })
}

/**
 * Document sources: connect / list (secret-free) / disconnect per provider, the workspace +
 * DocKind role links, the interactive document-interview session, and batch ref resolution.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerDocumentSourceTests(harness: ConformanceHarness): void {
  describe('document sources', () => {
    // GitHub docs are an IMPLICIT connection: they ride the workspace's installed GitHub
    // App/PAT, so a facade that carries an installation (local mode always does, via its
    // GITHUB_PAT) surfaces `github` in every workspace's connection list with no stored
    // row — while a facade with no installation (Node/Worker here) does not. These
    // credentialed-source lifecycle assertions are orthogonal to that, so compare on the
    // EXPLICITLY-connected (non-github) sources to stay correct on both kinds of facade.
    // The implicit path itself is covered by the DocumentConnectionService /
    // GitHubDocsProvider unit tests.
    const explicit = (connections: { source: string }[]) =>
      connections.map((c) => c.source).filter((s) => s !== 'github')

    it('connects, lists (secret-free), and disconnects a document source', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const base = `/workspaces/${workspace.id}/document-sources`

      // The module is wired on every facade: a fresh workspace lists no connections
      // (a 200), not the 503 a missing documents module would return.
      const initial = await call<{ connections: { source: string }[] }>(
        'GET',
        `${base}/connections`,
      )
      expect(initial.status).toBe(200)
      expect(explicit(initial.body.connections)).toEqual([])

      // Connect Notion (a single internal-integration token; normalizeConnection is
      // pure, so no network). The credential is encrypted at rest and never echoed.
      const connected = await call<{ source: string; label: string }>(
        'POST',
        `${base}/notion/connect`,
        { credentials: { apiToken: 'secret-notion-token-xyz' } },
      )
      expect(connected.status).toBe(201)
      expect(connected.body.source).toBe('notion')
      expect(JSON.stringify(connected.body)).not.toContain('secret-notion-token')

      // It lists back as metadata only — the token is never on the wire.
      const listed = await call<{ connections: { source: string }[] }>('GET', `${base}/connections`)
      expect(explicit(listed.body.connections)).toEqual(['notion'])
      expect(JSON.stringify(listed.body)).not.toContain('secret-notion-token')

      // Disconnect tombstones it; the list goes empty again.
      const del = await call('DELETE', `${base}/notion/connection`)
      expect(del.status).toBe(204)
      const afterDelete = await call<{ connections: { source: string }[] }>(
        'GET',
        `${base}/connections`,
      )
      expect(explicit(afterDelete.body.connections)).toEqual([])
    })

    it('connects, lists (secret-free), and disconnects Figma (per-workspace PAT)', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const base = `/workspaces/${workspace.id}/document-sources`

      // Figma is wired on every facade beside Notion/Confluence (a per-workspace PAT;
      // normalizeConnection is pure, so no network). The token never leaves the backend.
      const connected = await call<{ source: string; label: string }>(
        'POST',
        `${base}/figma/connect`,
        { credentials: { apiToken: 'figd_secret-figma-token-xyz' } },
      )
      expect(connected.status).toBe(201)
      expect(connected.body.source).toBe('figma')
      expect(JSON.stringify(connected.body)).not.toContain('secret-figma-token')

      const listed = await call<{ connections: { source: string }[] }>('GET', `${base}/connections`)
      expect(explicit(listed.body.connections)).toEqual(['figma'])
      expect(JSON.stringify(listed.body)).not.toContain('secret-figma-token')

      const del = await call('DELETE', `${base}/figma/connection`)
      expect(del.status).toBe(204)
      const afterDelete = await call<{ connections: { source: string }[] }>(
        'GET',
        `${base}/connections`,
      )
      expect(explicit(afterDelete.body.connections)).toEqual([])
    })

    it('canonicalises a pasted ref before anything is written, and names a wrong-source paste', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const base = `/workspaces/${workspace.id}/document-sources`

      // The link a designer actually copies out of Figma: a title segment plus the `?p=` / `&t=`
      // params the share button appends, on top of the frame's node id. Resolving it needs NO
      // connection and NO upstream call, which is exactly what lets an attach surface run this
      // before the task is saved rather than discovering the verdict through a failed import.
      const pasted =
        'https://www.figma.com/design/6k0gqOC6ppDMAziCmZ2Gv9/Project-Redwood--Autopilot-AI-' +
        '?node-id=5765-57229&p=f&t=J1SrKp6sgJm9CIeQ-0'
      const resolved = await call<{
        source: string
        externalId: string
        canonicalUrl: string | null
        droppedScope: string | null
      }>('POST', `${base}/figma/resolve-ref`, { ref: pasted })
      expect(resolved.status).toBe(200)
      expect(resolved.body).toEqual({
        source: 'figma',
        externalId: '6k0gqOC6ppDMAziCmZ2Gv9:5765:57229',
        canonicalUrl: 'https://www.figma.com/design/6k0gqOC6ppDMAziCmZ2Gv9?node-id=5765-57229',
        droppedScope: null,
      })

      // A node id the parser cannot read (Figma's own Copy link emits one for any component
      // instance) resolves to the whole FILE. That is a valid reference with a valid canonical URL,
      // so the widening is invisible unless the answer names what it dropped: an attach surface
      // showing only "trimmed to the supported form" would tell someone who linked one frame
      // nothing about the agent then reading the entire design.
      const widened = await call<{ externalId: string; droppedScope: string | null }>(
        'POST',
        `${base}/figma/resolve-ref`,
        { ref: 'https://www.figma.com/design/6k0gqOC6ppDMAziCmZ2Gv9/R?node-id=I2649:14930;2649:1' },
      )
      expect(widened.status).toBe(200)
      expect(widened.body.externalId).toBe('6k0gqOC6ppDMAziCmZ2Gv9')
      expect(widened.body.droppedScope).toBe('I2649:14930;2649:1')

      // The SAME link aimed at the wrong source is a redirectable paste, not a malformed one, and
      // the reason says so: the correction is switching sources with the text unchanged. A single
      // "unrecognized" would tell someone their perfectly good design link is broken.
      const wrongSource = await call<{ error: { details?: Record<string, unknown> } }>(
        'POST',
        `${base}/notion/resolve-ref`,
        { ref: pasted },
      )
      expect(wrongSource.status).toBe(422)
      expect(wrongSource.body.error.details?.reason).toBe('document_ref_claimed_by_other_source')
      expect(wrongSource.body.error.details?.claimedBy).toBe('figma')

      // Text no configured source recognises is the other refusal, and it carries the format this
      // source DOES accept, so the correction is stated rather than left to be guessed.
      const junk = await call<{ error: { details?: Record<string, unknown> } }>(
        'POST',
        `${base}/figma/resolve-ref`,
        { ref: 'https://example.com/not-a-design' },
      )
      expect(junk.status).toBe(422)
      expect(junk.body.error.details?.reason).toBe('document_ref_unrecognized')
      expect(junk.body.error.details?.claimedBy).toBeUndefined()
      expect(junk.body.error.details?.expected).toBeTruthy()
    })

    it('wires Linear as a document source on every facade (connect, list, disconnect)', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const base = `/workspaces/${workspace.id}/document-sources`

      // Linear is registered symmetrically across runtimes: a personal API key
      // connects, lists back as metadata only, and disconnects — the same lifecycle
      // as Notion, proving the provider is wired (not 503/404) on this facade.
      const connected = await call<{ source: string }>('POST', `${base}/linear/connect`, {
        credentials: { apiKey: 'lin_api_secret_key_123' },
      })
      expect(connected.status).toBe(201)
      expect(connected.body.source).toBe('linear')
      expect(JSON.stringify(connected.body)).not.toContain('lin_api_secret_key_123')

      const listed = await call<{ connections: { source: string }[] }>('GET', `${base}/connections`)
      expect(explicit(listed.body.connections)).toEqual(['linear'])
      expect(JSON.stringify(listed.body)).not.toContain('lin_api_secret_key_123')

      const del = await call('DELETE', `${base}/linear/connection`)
      expect(del.status).toBe(204)
      const afterDelete = await call<{ connections: { source: string }[] }>(
        'GET',
        `${base}/connections`,
      )
      expect(explicit(afterDelete.body.connections)).toEqual([])
    })

    it('connects, lists (secret-free), and disconnects Zeplin (per-workspace PAT)', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const base = `/workspaces/${workspace.id}/document-sources`

      // Zeplin is the second design source, wired on every facade beside Figma (a
      // per-workspace Bearer PAT; normalizeConnection is pure, so no network). It proves
      // the design abstraction is not Figma-shaped — a different content model (screens +
      // a handoff design system) rides the same provider port. The token never leaves the
      // backend.
      const connected = await call<{ source: string }>('POST', `${base}/zeplin/connect`, {
        credentials: { apiToken: 'zpn-secret-zeplin-token-xyz' },
      })
      expect(connected.status).toBe(201)
      expect(connected.body.source).toBe('zeplin')
      expect(JSON.stringify(connected.body)).not.toContain('secret-zeplin-token')

      const listed = await call<{ connections: { source: string }[] }>('GET', `${base}/connections`)
      expect(explicit(listed.body.connections)).toEqual(['zeplin'])
      expect(JSON.stringify(listed.body)).not.toContain('secret-zeplin-token')

      const del = await call('DELETE', `${base}/zeplin/connection`)
      expect(del.status).toBe(204)
      const afterDelete = await call<{ connections: { source: string }[] }>(
        'GET',
        `${base}/connections`,
      )
      expect(explicit(afterDelete.body.connections)).toEqual([])
    })
  })
}

/**
 * Document + task PERSISTENCE probes: the workspace+DocKind role links, an `upload`-origin
 * document, the interactive document-interview session, and the batched issue reads.
 *
 * Split from the HTTP lifecycle tests above purely to keep each function within the per-function
 * line budget, on the same rule that split this file from the suite. Every test is unchanged.
 * What they have in common: each drives a repository directly, because the write path needs a
 * live source (or an LLM) the dev-open HTTP path cannot reach, so the probe is the only place a
 * facade that maps a column differently fails a shared test.
 */
function registerDocumentPersistenceTests(harness: ConformanceHarness): void {
  describe('document + task persistence', () => {
    it('persists workspace+DocKind template (singular) and exemplar (multi) role links', async () => {
      // WS1 items 2–4: the role-tagged document links a workspace attaches to a DocKind. The
      // link WRITE path needs an imported document row (import needs a live source the dev-open
      // HTTP path can't reach), so drive the persistence through the repository probe — asserting
      // template singular-replace, exemplar multi, the management list, and the parsed-template
      // override behave identically on D1 and Postgres.
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const ws = workspace.id
      const repo = app.documentRepository()
      const doc = (externalId: string, title: string, body: string): DocumentRecord => ({
        workspaceId: ws,
        source: 'github',
        externalId,
        title,
        url: `https://github.com/o/r/blob/HEAD/${externalId}`,
        excerpt: '',
        body,
        contentHash: '',
        sourceVersion: null,
        linkedBlockId: null,
        role: null,
        docKind: null,
        syncedAt: 1_000,
        deletedAt: null,
      })
      await repo.upsert(
        doc(
          'docs/templates/rfc-a.md',
          'RFC template A',
          '# RFC\n\n## Summary\n\n## Motivation\n\n## Rollout',
        ),
      )
      await repo.upsert(
        doc('docs/templates/rfc-b.md', 'RFC template B', '# RFC\n\n## Abstract\n\n## Design'),
      )
      await repo.upsert(
        doc('docs/examples/good-rfc.md', 'A great RFC', '# Example RFC\n\n## Summary'),
      )

      // Link A as the rfc template.
      await repo.clearRoleForKind(ws, 'template', 'rfc')
      await repo.setRole(ws, 'github', 'docs/templates/rfc-a.md', 'template', 'rfc')
      const tplA = await repo.getRoleLink(ws, 'template', 'rfc')
      expect(tplA?.externalId).toBe('docs/templates/rfc-a.md')
      // The linked template's parsed sections become the kind's effective template — the SAME
      // override the doc-quality gate resolves, so the writer and gate never disagree.
      expect(resolveDocTemplate('rfc', tplA!.body).sections.map((s) => s.title)).toEqual([
        'Summary',
        'Motivation',
        'Rollout',
      ])

      // Relinking a new template for the kind REPLACES the prior one (singular per kind).
      await repo.clearRoleForKind(ws, 'template', 'rfc')
      await repo.setRole(ws, 'github', 'docs/templates/rfc-b.md', 'template', 'rfc')
      expect((await repo.getRoleLink(ws, 'template', 'rfc'))?.externalId).toBe(
        'docs/templates/rfc-b.md',
      )
      expect((await repo.get(ws, 'github', 'docs/templates/rfc-a.md'))?.role).toBeNull()

      // Exemplars are additive (multi-valued per kind).
      await repo.setRole(ws, 'github', 'docs/examples/good-rfc.md', 'exemplar', 'rfc')
      expect((await repo.listRoleLinks(ws, 'exemplar', 'rfc')).map((d) => d.externalId)).toEqual([
        'docs/examples/good-rfc.md',
      ])

      // The management list surfaces every role-tagged document (template + exemplars).
      const all = await repo.listRoleLinksByWorkspace(ws)
      expect(new Set(all.map((d) => `${d.role}:${d.externalId}`))).toEqual(
        new Set(['template:docs/templates/rfc-b.md', 'exemplar:docs/examples/good-rfc.md']),
      )

      // Unlinking clears the tag — the built-in template resumes for the kind.
      await repo.clearRole(ws, 'github', 'docs/templates/rfc-b.md')
      expect(await repo.getRoleLink(ws, 'template', 'rfc')).toBeNull()
    })

    it('persists an `upload`-origin document, with no source URL, identically', async () => {
      // A document handed to the platform through `POST /api/v1/services/:id/tasks` rather than
      // fetched from a connected source. It is the first row whose `source` names no provider and
      // whose `url` is empty, and both facades have to agree about that: a repo that coerced the
      // empty url to null (or refused the unknown origin) would take the attached spec off the
      // agent's context on ONE runtime only, which reads as a healthy run against a missing spec.
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const ws = workspace.id
      const repo = app.documentRepository()

      await repo.upsert({
        workspaceId: ws,
        source: 'upload',
        externalId: 'doc_upload_1',
        title: 'Checkout PRD',
        url: '',
        excerpt: 'Support split payments.',
        body: '# Checkout PRD\n\nSupport split payments.',
        contentHash: 'abc123',
        // An upload has no source, hence no version: nothing can ever re-probe it.
        sourceVersion: null,
        linkedBlockId: null,
        role: null,
        docKind: null,
        syncedAt: 2_000,
        deletedAt: null,
      })

      const stored = await repo.get(ws, 'upload', 'doc_upload_1')
      expect(stored?.url).toBe('')
      expect(stored?.body).toBe('# Checkout PRD\n\nSupport split payments.')

      // It attaches to a block like any other document, which is how it reaches the agent.
      await repo.linkBlock(ws, 'upload', 'doc_upload_1', 'task_1')
      expect((await repo.listByBlock(ws, 'task_1')).map((d) => d.externalId)).toEqual([
        'doc_upload_1',
      ])

      // And its empty url must never be matched by a URL lookup, which resolves links a task's
      // DESCRIPTION names: one uploaded document answering for another would be silent.
      expect(await repo.getByUrl(ws, '')).toBeNull()
    })

    it('batch-resolves, batch-links and detaches documents identically across origins', async () => {
      // The batched trio behind attaching a LIST of documents to one task. Every one of them
      // spans ORIGINS (an imported page beside an uploaded body), which is where a facade that
      // grouped or filtered by origin differently would diverge — and the divergence is silent:
      // a document missing from the batch read is a document missing from the agent's corpus.
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const ws = workspace.id
      const repo = app.documentRepository()

      const base = {
        workspaceId: ws,
        title: 'doc',
        excerpt: 'x',
        body: 'x',
        contentHash: 'h',
        sourceVersion: null,
        linkedBlockId: null,
        role: null,
        docKind: null,
        syncedAt: 3_000,
        deletedAt: null,
      }
      await repo.upsert({ ...base, source: 'confluence', externalId: 'PAGE-1', url: 'https://w/1' })
      await repo.upsert({ ...base, source: 'confluence', externalId: 'PAGE-2', url: 'https://w/2' })
      await repo.upsert({ ...base, source: 'upload', externalId: 'doc_up', url: '' })

      const refs = [
        { source: 'confluence', externalId: 'PAGE-1' },
        { source: 'upload', externalId: 'doc_up' },
      ] as const
      // A ref that resolves nothing is absent rather than an error, and never drags in a
      // same-id row from another origin.
      const found = await repo.listByRefs(ws, [...refs, { source: 'notion', externalId: 'PAGE-1' }])
      expect(found.map((d) => `${d.source}:${d.externalId}`).sort()).toEqual([
        'confluence:PAGE-1',
        'upload:doc_up',
      ])

      await repo.linkBlockMany(ws, refs, 'task_1')
      expect((await repo.listByBlock(ws, 'task_1')).map((d) => d.externalId).sort()).toEqual([
        'PAGE-1',
        'doc_up',
      ])
      // PAGE-2 was not named, so it stays unattached: a batch write must not widen to its origin.
      expect((await repo.get(ws, 'confluence', 'PAGE-2'))?.linkedBlockId).toBeNull()

      // The block-delete cascade's detach, keyed by BLOCK rather than by ref — a link naming a
      // deleted block would otherwise make its document look permanently spoken for.
      await repo.detachBlocks(ws, ['task_1'])
      expect(await repo.listByBlock(ws, 'task_1')).toEqual([])
      // The documents themselves survive; only the link went.
      expect(await repo.get(ws, 'upload', 'doc_up')).not.toBeNull()
    })

    it('persists an interactive document-interview session identically (WS5)', async () => {
      // The interactive-interview session (WS5) is written by the interviewer LLM (off in
      // conformance), so — like the role-link probe above — exercise the persistence through
      // the repository directly. Asserting upsert / getByBlock-newest-wins / get / deleteByBlock
      // here means a facade that maps a column differently (D1 vs Drizzle) fails a shared test.
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const ws = workspace.id
      const repo = app.docInterviewRepository()

      // A fresh block has no session.
      expect(await repo.getByBlock(ws, 'task_doc')).toBeNull()

      // Round-trip an `awaiting` session with a pending question.
      await repo.upsert(ws, {
        id: 'dis-1',
        blockId: 'task_doc',
        status: 'awaiting',
        round: 1,
        maxRounds: 4,
        qa: [{ id: 'diq-1', question: 'Who is the audience?', answer: '' }],
        brief: null,
        model: 'openai:gpt',
        createdAt: 1_000,
        updatedAt: 1_000,
      })
      const loaded = await repo.getByBlock(ws, 'task_doc')
      expect(loaded?.status).toBe('awaiting')
      expect(loaded?.round).toBe(1)
      expect(loaded?.qa).toEqual([{ id: 'diq-1', question: 'Who is the audience?', answer: '' }])
      expect(await repo.get(ws, 'dis-1')).not.toBeNull()

      // An upsert on the same id converges it (answered digest + synthesized brief).
      await repo.upsert(ws, {
        id: 'dis-1',
        blockId: 'task_doc',
        status: 'done',
        round: 2,
        maxRounds: 4,
        qa: [{ id: 'diq-1', question: 'Who is the audience?', answer: 'Platform engineers' }],
        brief: '# Authoring brief\n\nWrite for platform engineers.',
        model: 'openai:gpt',
        createdAt: 1_000,
        updatedAt: 2_000,
      })
      const done = await repo.getByBlock(ws, 'task_doc')
      expect(done?.status).toBe('done')
      expect(done?.brief).toContain('platform engineers')
      expect(done?.qa[0]?.answer).toBe('Platform engineers')

      // deleteByBlock clears the block's session(s).
      await repo.deleteByBlock(ws, 'task_doc')
      expect(await repo.getByBlock(ws, 'task_doc')).toBeNull()
    })

    it('batch-resolves imported issues by (source, externalId) ref (listByRefs)', async () => {
      // The engine resolves the tracker issues a task's description names explicitly via a
      // single batched read (AgentContextBuilder → TaskRepository.listByRefs), never a
      // point-read per reference (an N+1). The import WRITE path needs a live source the
      // dev-open HTTP `call` path can't reach, so exercise the read through the repository
      // directly — asserting the chunked-`IN`-per-source batch behaves identically on D1 and
      // Postgres (a facade that mapped a column or the source filter differently fails here).
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const ws = workspace.id
      const repo = app.taskRepository()
      const task = (source: TaskRecord['source'], externalId: string): TaskRecord => ({
        workspaceId: ws,
        source,
        externalId,
        title: `Issue ${externalId}`,
        url: `https://tracker/${externalId}`,
        status: 'open',
        type: 'Story',
        assignee: null,
        priority: null,
        labels: [],
        description: `Body of ${externalId}`,
        comments: [],
        excerpt: '',
        linkedBlockId: null,
        syncedAt: 1_000,
        deletedAt: null,
      })
      await repo.upsert(task('jira', 'PROJ-1'))
      await repo.upsert(task('jira', 'PROJ-2'))
      await repo.upsert(task('github', 'octo/repo#7'))

      // Empty input is a no-op (no query issued).
      expect(await repo.listByRefs(ws, [])).toEqual([])

      // A mixed set spanning both sources resolves only the rows that exist; a matching
      // key under the WRONG source (PROJ-1 as github) and an absent key resolve to nothing.
      const resolved = await repo.listByRefs(ws, [
        { source: 'jira', externalId: 'PROJ-1' },
        { source: 'jira', externalId: 'MISSING-9' },
        { source: 'github', externalId: 'octo/repo#7' },
        { source: 'github', externalId: 'PROJ-1' },
      ])
      expect(new Set(resolved.map((t) => `${t.source}:${t.externalId}`))).toEqual(
        new Set(['jira:PROJ-1', 'github:octo/repo#7']),
      )
      // Full records come back (not just keys), so the caller renders bodies without re-reading.
      expect(resolved.find((t) => t.externalId === 'PROJ-1')?.description).toBe('Body of PROJ-1')
    })

    it('admits exactly one block per issue under CONCURRENT claims (claimBlockLink)', async () => {
      // "One task per ticket" is an invariant on `linked_block_id`, and the writers race for real:
      // a redelivering tracker webhook is precisely two filings of one issue in flight at once.
      // A read-then-`linkBlock` cannot hold the invariant (at READ COMMITTED both readers see it
      // free), and the failure is invisible on a SEQUENTIAL test, which is why this one drives
      // the claims CONCURRENTLY, and why it lives here rather than in either facade's own suite:
      // SQLite serializes writers, so the racy code is accidentally safe on D1 and loses data
      // only on Postgres.
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const ws = workspace.id
      const repo = app.taskRepository()
      await repo.upsert({
        workspaceId: ws,
        source: 'jira',
        externalId: 'PROJ-9',
        title: 'Issue PROJ-9',
        url: 'https://tracker/PROJ-9',
        status: 'open',
        type: 'Story',
        assignee: null,
        priority: null,
        labels: [],
        description: 'Body',
        comments: [],
        excerpt: '',
        linkedBlockId: null,
        syncedAt: 1_000,
        deletedAt: null,
      })

      const outcomes = await Promise.all([
        repo.claimBlockLink(ws, 'jira', 'PROJ-9', 'task_a'),
        repo.claimBlockLink(ws, 'jira', 'PROJ-9', 'task_b'),
      ])
      expect(outcomes.filter(Boolean)).toHaveLength(1)

      // The winner is what the row actually holds, so the loser's 409 can name it truthfully.
      const winner = outcomes[0] ? 'task_a' : 'task_b'
      expect((await repo.get(ws, 'jira', 'PROJ-9'))?.linkedBlockId).toBe(winner)

      // A late third filing loses against the settled row rather than re-pointing it.
      expect(await repo.claimBlockLink(ws, 'jira', 'PROJ-9', 'task_c')).toBe(false)
      expect((await repo.get(ws, 'jira', 'PROJ-9'))?.linkedBlockId).toBe(winner)

      // Re-claiming with the block that already holds it WINS: a caller retrying after a lost
      // response settles idempotently instead of refusing against its own earlier write.
      expect(await repo.claimBlockLink(ws, 'jira', 'PROJ-9', winner)).toBe(true)

      // And the unconditional `linkBlock` is still the deliberate re-point (the manual link
      // action, the recurring intake's per-fire move): the claim narrows nothing for it.
      await repo.linkBlock(ws, 'jira', 'PROJ-9', 'task_c')
      expect((await repo.get(ws, 'jira', 'PROJ-9'))?.linkedBlockId).toBe('task_c')
    })

    it('detaches every issue filed as a doomed block, across sources (unlinkAllFromBlocks)', async () => {
      // The block-delete cascade's detach, keyed by BLOCK rather than by issue: a delete knows the
      // doomed subtree's ids, not which issues name them. It spans SOURCES, which is where a
      // facade that grouped or filtered by source differently would diverge, and the divergence is
      // silent in the worst direction: an issue left naming a deleted block is excluded from the
      // intake sweep forever and refuses every future filing of its ticket.
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const ws = workspace.id
      const repo = app.taskRepository()
      const task = (source: TaskRecord['source'], externalId: string): TaskRecord => ({
        workspaceId: ws,
        source,
        externalId,
        title: `Issue ${externalId}`,
        url: `https://tracker/${externalId}`,
        status: 'open',
        type: 'Bug',
        assignee: null,
        priority: null,
        labels: [],
        description: `Body of ${externalId}`,
        comments: [],
        excerpt: '',
        linkedBlockId: null,
        syncedAt: 1_000,
        deletedAt: null,
      })
      await repo.upsert(task('jira', 'PROJ-11'))
      await repo.upsert(task('github', 'octo/repo#11'))
      await repo.linkBlock(ws, 'jira', 'PROJ-11', 'task_doomed')
      await repo.linkBlock(ws, 'github', 'octo/repo#11', 'task_survivor')

      // Empty input is a no-op (no query issued), which is what an unwired cascade hands it.
      await repo.unlinkAllFromBlocks(ws, [])
      expect((await repo.get(ws, 'jira', 'PROJ-11'))?.linkedBlockId).toBe('task_doomed')

      await repo.unlinkAllFromBlocks(ws, ['task_doomed', 'task_never_existed'])

      // Only the named block's issue was detached; the other block keeps its link.
      expect(await repo.listByBlock(ws, 'task_doomed')).toEqual([])
      expect((await repo.get(ws, 'jira', 'PROJ-11'))?.linkedBlockId).toBeNull()
      expect((await repo.get(ws, 'github', 'octo/repo#11'))?.linkedBlockId).toBe('task_survivor')

      // The issue rows themselves survive: only the link went, so the ticket returns to the pool
      // rather than disappearing from the projection.
      expect((await repo.get(ws, 'jira', 'PROJ-11'))?.title).toBe('Issue PROJ-11')
      // Which is the whole point: a filing of it now succeeds instead of losing the claim.
      expect(await repo.claimBlockLink(ws, 'jira', 'PROJ-11', 'task_refiled')).toBe(true)
    })
  })
}

/**
 * Dispatch-time document FRESHNESS, at the persistence layer: the `source_version` column the refresh
 * compares a cheap `probeVersion` against.
 *
 * Its own function rather than another test inside `registerDocumentPersistenceTests`, which is at its
 * per-function line budget. Its own `describe` for the same reason, and because what it covers is one
 * cohesive column rather than the link/role surface the others drive.
 */
function registerDocumentFreshnessTests(harness: ConformanceHarness): void {
  describe('document freshness persistence', () => {
    it('round-trips the source version a document body was imported at, and its absence', async () => {
      // The token the dispatch-time refresh COMPARES: a facade that dropped it on the upsert, or read
      // an absent one back as `''`, would make every linked document look permanently unconfirmable
      // and re-download the whole design on every step dispatch — a silent cost, not an error. The
      // two cases have to stay distinguishable, which is why the column is nullable rather than
      // defaulted: a recorded version means "this body is provably that revision", NULL means
      // "cannot be proven, re-import once".
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const ws = workspace.id
      const repo = app.documentRepository()
      const base = {
        workspaceId: ws,
        source: 'figma' as const,
        title: 'Checkout flow',
        url: 'https://figma.com/design/file1',
        excerpt: 'Checkout',
        body: '## Checkout',
        contentHash: 'h',
        linkedBlockId: null,
        role: null,
        docKind: null,
        syncedAt: 4_000,
        deletedAt: null,
      }
      await repo.upsert({ ...base, externalId: 'file1:1-2', sourceVersion: '2317456' })
      await repo.upsert({ ...base, externalId: 'file2:3-4', sourceVersion: null })

      expect((await repo.get(ws, 'figma', 'file1:1-2'))?.sourceVersion).toBe('2317456')
      expect((await repo.get(ws, 'figma', 'file2:3-4'))?.sourceVersion).toBeNull()

      // A re-import overwrites it — the write that makes an un-versioned row self-heal exactly once.
      await repo.upsert({ ...base, externalId: 'file2:3-4', sourceVersion: '99' })
      expect((await repo.get(ws, 'figma', 'file2:3-4'))?.sourceVersion).toBe('99')

      // And it survives the batch + block-scoped reads the dispatch path actually uses, not just the
      // point read: the refresher receives its records from `listByBlock`/`listByRefs`.
      await repo.linkBlock(ws, 'figma', 'file1:1-2', 'task_fresh')
      expect((await repo.listByBlock(ws, 'task_fresh'))[0]?.sourceVersion).toBe('2317456')
      const batched = await repo.listByRefs(ws, [{ source: 'figma', externalId: 'file1:1-2' }])
      expect(batched[0]?.sourceVersion).toBe('2317456')
    })

    it('re-confirms one stored document on demand, and NAMES the gap when it cannot', async () => {
      // The manual dual of the dispatch-time refresh: what a designer clicks when they want to
      // know whether the frame an agent will read is the one they just edited. Asserted here
      // because the route is wired per facade and a runtime that forgot it would leave the SPA's
      // refresh action permanently broken on that deployment only.
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const ws = workspace.id
      await app.documentRepository().upsert({
        workspaceId: ws,
        source: 'figma',
        externalId: 'file9:1-2',
        title: 'Checkout flow',
        url: 'https://figma.com/design/file9',
        excerpt: 'Checkout',
        body: '## Checkout',
        contentHash: 'h',
        sourceVersion: '17',
        linkedBlockId: null,
        role: null,
        docKind: null,
        syncedAt: 4_000,
        deletedAt: null,
      })

      // No Figma connection in this workspace, so the answer is a VERDICT rather than an error:
      // the stored copy is still perfectly usable and the person is told which of the four gaps
      // applies, because reconnecting the source and waiting out an outage are different fixes.
      const refreshed = await app.call<{
        document: { externalId: string; title: string }
        freshness: { status: string; reason?: string }
      }>('POST', `/workspaces/${ws}/documents/refresh`, {
        source: 'figma',
        externalId: 'file9:1-2',
      })
      expect(refreshed.status).toBe(200)
      expect(refreshed.body.document.title).toBe('Checkout flow')
      expect(refreshed.body.freshness).toEqual({ status: 'unconfirmed', reason: 'not_connected' })

      // A document this workspace never imported is a refusal, not a verdict: there is no stored
      // body to report on, so answering `unconfirmed` would describe a row that does not exist.
      const missing = await app.call('POST', `/workspaces/${ws}/documents/refresh`, {
        source: 'figma',
        externalId: 'never-imported',
      })
      expect(missing.status).toBe(422)
    })
  })
}
