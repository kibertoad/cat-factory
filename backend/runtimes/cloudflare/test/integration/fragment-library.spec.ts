import type {
  FragmentSource,
  FragmentSourceStatus,
  FragmentSyncResult,
  PromptFragment,
  ResolvedFragment,
} from '@cat-factory/kernel'
import { beforeEach, describe, expect, it } from 'vitest'
import { fragmentLibraryDeps, makeApp, type TestApp } from '../helpers'
import { FakeGitHubClient } from '../fakes/FakeGitHubClient'

describe('prompt-fragment library (ADR 0006)', () => {
  describe('when the module is not configured', () => {
    it('reports the tier endpoint as unavailable (503)', async () => {
      // The library is on by default now, so simulate an explicit opt-out by
      // un-wiring its repositories (what `PROMPT_LIBRARY_ENABLED=false` produces).
      const app = makeApp(undefined, {
        promptFragmentRepository: undefined,
        fragmentSourceRepository: undefined,
      })
      const { workspace } = await app.createWorkspace()
      const res = await app.call('GET', `/workspaces/${workspace.id}/prompt-fragments`)
      expect(res.status).toBe(503)
    })
  })

  describe('workspace-tier CRUD + resolved merge', () => {
    let app: TestApp
    let wsId: string

    beforeEach(async () => {
      app = makeApp(undefined, fragmentLibraryDeps())
      const { workspace } = await app.createWorkspace()
      wsId = workspace.id
    })

    it('creates, lists and folds a hand-authored fragment into the resolved catalog', async () => {
      const created = await app.call<PromptFragment>(
        'POST',
        `/workspaces/${wsId}/prompt-fragments`,
        {
          title: 'Logging discipline',
          summary: 'Structured logs, no secrets.',
          body: 'Emit JSON logs with a correlation id; never log secrets.',
          tags: ['backend'],
        },
      )
      expect(created.status).toBe(201)
      expect(created.body.id).toBe('logging-discipline')

      const tier = await app.call<PromptFragment[]>('GET', `/workspaces/${wsId}/prompt-fragments`)
      expect(tier.body.map((f) => f.id)).toContain('logging-discipline')

      const resolved = await app.call<ResolvedFragment[]>(
        'GET',
        `/workspaces/${wsId}/prompt-fragments/resolved`,
      )
      const mine = resolved.body.find((f) => f.id === 'logging-discipline')
      expect(mine?.tier).toBe('workspace')
      // The built-in tier is still merged in underneath.
      expect(resolved.body.find((f) => f.id === 'node.performance')?.tier).toBe('builtin')
    })

    it('shadows a built-in fragment by re-defining its id at the workspace tier', async () => {
      await app.call('POST', `/workspaces/${wsId}/prompt-fragments`, {
        id: 'node.performance',
        title: 'Our perf rules',
        summary: 'Team-specific performance guidance.',
        body: 'Use our profiler; budget p95 < 200ms.',
      })
      const resolved = await app.call<ResolvedFragment[]>(
        'GET',
        `/workspaces/${wsId}/prompt-fragments/resolved`,
      )
      const shadowed = resolved.body.find((f) => f.id === 'node.performance')
      expect(shadowed?.tier).toBe('workspace')
      expect(shadowed?.body).toContain('p95')
    })

    it('suppresses an inherited built-in fragment with a tombstone (DELETE)', async () => {
      const before = await app.call<ResolvedFragment[]>(
        'GET',
        `/workspaces/${wsId}/prompt-fragments/resolved`,
      )
      expect(before.body.map((f) => f.id)).toContain('node.performance')

      const del = await app.call('DELETE', `/workspaces/${wsId}/prompt-fragments/node.performance`)
      expect(del.status).toBe(204)

      const after = await app.call<ResolvedFragment[]>(
        'GET',
        `/workspaces/${wsId}/prompt-fragments/resolved`,
      )
      expect(after.body.map((f) => f.id)).not.toContain('node.performance')
    })
  })

  describe('repo-sourced fragments', () => {
    let app: TestApp
    let wsId: string
    let github: FakeGitHubClient

    beforeEach(async () => {
      github = new FakeGitHubClient()
      github.files = {
        'guidelines/backend.md': {
          sha: 'sha-backend-1',
          content: [
            '---',
            'title: Backend error handling',
            'summary: Fail fast, wrap external errors.',
            'tags: [backend, db]',
            'appliesTo:',
            '  blockTypes: [service, api]',
            '---',
            '',
            '- Validate inputs at the boundary.',
            '- Wrap third-party errors.',
          ].join('\n'),
        },
        'guidelines/README.md': {
          sha: 'sha-readme-1',
          content: 'Not a guideline, but still markdown — should import leniently.',
        },
        'guidelines/logo.png': { sha: 'sha-bin', content: 'binary' },
      }
      app = makeApp(undefined, fragmentLibraryDeps({ client: github }))
      const { workspace } = await app.createWorkspace()
      wsId = workspace.id
    })

    it('links a repo, syncs its Markdown into the catalog, and resolves it', async () => {
      const source = await app.call<FragmentSource>(
        'POST',
        `/workspaces/${wsId}/fragment-sources`,
        { repoOwner: 'acme', repoName: 'guidelines', dirPath: 'guidelines' },
      )
      expect(source.status).toBe(201)
      expect(source.body.lastSyncedSha).toBeNull()

      const sync = await app.call<FragmentSyncResult>(
        'POST',
        `/workspaces/${wsId}/fragment-sources/${source.body.id}/sync`,
      )
      // Two markdown files import; the .png is skipped.
      expect(sync.body.upserted).toBe(2)
      expect(sync.body.tombstoned).toBe(0)
      expect(sync.body.lastSyncedSha).not.toBeNull()

      const resolved = await app.call<ResolvedFragment[]>(
        'GET',
        `/workspaces/${wsId}/prompt-fragments/resolved`,
      )
      const sourced = resolved.body.find((f) => f.title === 'Backend error handling')
      expect(sourced?.tier).toBe('workspace')
      expect(sourced?.tags).toEqual(['backend', 'db'])
      expect(sourced?.appliesTo?.blockTypes).toEqual(['service', 'api'])
      expect(sourced?.source?.path).toBe('guidelines/backend.md')
    })

    it('reports no changes after a sync and detects a changed blob', async () => {
      const source = await app.call<FragmentSource>(
        'POST',
        `/workspaces/${wsId}/fragment-sources`,
        { repoOwner: 'acme', repoName: 'guidelines', dirPath: 'guidelines' },
      )
      await app.call('POST', `/workspaces/${wsId}/fragment-sources/${source.body.id}/sync`)

      const clean = await app.call<FragmentSourceStatus>(
        'GET',
        `/workspaces/${wsId}/fragment-sources/${source.body.id}/status`,
      )
      expect(clean.body.changed).toBe(false)
      expect(clean.body.changedCount).toBe(0)

      // Upstream edit: same path, new blob sha.
      github.files['guidelines/backend.md']!.sha = 'sha-backend-2'
      const dirty = await app.call<FragmentSourceStatus>(
        'GET',
        `/workspaces/${wsId}/fragment-sources/${source.body.id}/status`,
      )
      expect(dirty.body.changed).toBe(true)
      expect(dirty.body.changedCount).toBe(1)
    })

    it("hides another tenant's source from sync/status/unlink (404, nothing mutated)", async () => {
      const source = await app.call<FragmentSource>(
        'POST',
        `/workspaces/${wsId}/fragment-sources`,
        { repoOwner: 'acme', repoName: 'guidelines', dirPath: 'guidelines' },
      )
      const { workspace: other } = await app.createWorkspace()

      // The other workspace's routes must not read, mutate or delete workspace A's source.
      const status = await app.call(
        'GET',
        `/workspaces/${other.id}/fragment-sources/${source.body.id}/status`,
      )
      expect(status.status).toBe(404)
      const sync = await app.call(
        'POST',
        `/workspaces/${other.id}/fragment-sources/${source.body.id}/sync`,
      )
      expect(sync.status).toBe(404)
      const unlink = await app.call(
        'DELETE',
        `/workspaces/${other.id}/fragment-sources/${source.body.id}`,
      )
      expect(unlink.status).toBe(404)

      // Still linked and syncable at its real owner.
      const mine = await app.call<FragmentSource[]>('GET', `/workspaces/${wsId}/fragment-sources`)
      expect(mine.body.map((s) => s.id)).toContain(source.body.id)
      const ownSync = await app.call(
        'POST',
        `/workspaces/${wsId}/fragment-sources/${source.body.id}/sync`,
      )
      expect(ownSync.status).toBe(200)
    })
  })

  // NOTE: the tenant library feeds the run path through `resolveBodiesForRun` (the
  // engine's `fragmentResolver`): an explicit, service-scoped selection (a frame's
  // `serviceFragmentIds`) plus block pins, resolved against the merged tenant catalog
  // and folded only into `code-aware` agents — see the cross-runtime conformance
  // suite's "service-scoped fragments + agent traits" tests. Only the automatic
  // per-run relevance selector is retired. This file covers the library's management
  // surface (tier CRUD + repo sources).
})
