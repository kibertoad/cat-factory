import { resolveDocTemplate } from '@cat-factory/agents'
import type {
  Block,
  DocumentRecord,
  SourceTask,
  TaskRecord,
  TaskSourceDiagnostic,
  TaskSourceState,
  WorkspaceSnapshot,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
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
    })
  })

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
  })

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
  })
}
