import type {
  FragmentOwnerKind,
  FragmentSourceRecord,
  FragmentSourceRepository,
  GitHubClient,
  PromptFragmentRecord,
  PromptFragmentRepository,
} from '@cat-factory/kernel'
import { beforeEach, describe, expect, it } from 'vitest'
import { FragmentSourceService } from './FragmentSourceService.js'

// Pure-logic coverage for the repo-source resync: the tombstone sweep is keyed by the
// fragment IDs the current tree produces (not by stale paths), so a rename of a file
// that pins an explicit frontmatter `id` keeps the fragment alive, while a file whose
// explicit `id` changed retires the old id. Also pins that the GitHub installation is
// resolved once per sync, never per file.

function fragKey(kind: FragmentOwnerKind, id: string, fragmentId: string): string {
  return `${kind}|${id}|${fragmentId}`
}

class FakeFragmentRepo implements PromptFragmentRepository {
  readonly rows = new Map<string, PromptFragmentRecord>()
  async listByOwner(kind: FragmentOwnerKind, id: string, includeDeleted = false) {
    return [...this.rows.values()].filter(
      (r) => r.ownerKind === kind && r.ownerId === id && (includeDeleted || r.deletedAt === null),
    )
  }
  async get(kind: FragmentOwnerKind, id: string, fragmentId: string) {
    return this.rows.get(fragKey(kind, id, fragmentId)) ?? null
  }
  async upsert(record: PromptFragmentRecord) {
    this.rows.set(fragKey(record.ownerKind, record.ownerId, record.fragmentId), record)
  }
  async softDelete(kind: FragmentOwnerKind, id: string, fragmentId: string, at: number) {
    const r = this.rows.get(fragKey(kind, id, fragmentId))
    if (r) r.deletedAt = at
  }
  async listBySource(sourceId: string) {
    return [...this.rows.values()].filter((r) => r.sourceId === sourceId && r.deletedAt === null)
  }
}

class FakeSourceRepo implements FragmentSourceRepository {
  readonly rows = new Map<string, FragmentSourceRecord>()
  async listByOwner(kind: FragmentOwnerKind, id: string) {
    return [...this.rows.values()].filter(
      (r) => r.ownerKind === kind && r.ownerId === id && r.deletedAt === null,
    )
  }
  async get(id: string) {
    return this.rows.get(id) ?? null
  }
  async upsert(record: FragmentSourceRecord) {
    this.rows.set(record.id, record)
  }
  async updateSyncState(id: string, lastSyncedSha: string, lastSyncedAt: number) {
    const r = this.rows.get(id)
    if (r) Object.assign(r, { lastSyncedSha, lastSyncedAt })
  }
  async softDelete(id: string, at: number) {
    const r = this.rows.get(id)
    if (r) r.deletedAt = at
  }
}

/** A GitHub fake serving an in-memory `files` map (full path → sha + content). */
function fakeGitHub(files: Record<string, { sha: string; content: string }>) {
  return {
    files,
    listDirectory: async () =>
      Object.entries(files).map(([path, f]) => ({
        path,
        name: path.split('/').pop()!,
        type: 'file',
        sha: f.sha,
      })),
    getFileContent: async (_i: number, _r: unknown, path: string) => {
      const f = files[path]
      return f ? { content: f.content, sha: f.sha } : null
    },
  }
}

function makeService(github: ReturnType<typeof fakeGitHub>) {
  const fragments = new FakeFragmentRepo()
  const sources = new FakeSourceRepo()
  let installationCalls = 0
  let seq = 0
  const service = new FragmentSourceService({
    fragmentSourceRepository: sources,
    promptFragmentRepository: fragments,
    githubClient: github as unknown as GitHubClient,
    resolveInstallationId: async () => {
      installationCalls++
      return 42
    },
    idGenerator: { next: (p?: string) => `${p ?? 'id'}_${++seq}` },
    clock: { now: () => 1_000_000 + seq++ },
  })
  return { service, fragments, installations: () => installationCalls }
}

const EXPLICIT_ID_FILE = (id: string) =>
  ['---', `id: ${id}`, 'title: Org performance rules', '---', '', '- Budget p95 < 200ms.'].join(
    '\n',
  )

describe('FragmentSourceService.sync', () => {
  let github: ReturnType<typeof fakeGitHub>
  let harness: ReturnType<typeof makeService>
  let sourceId: string

  beforeEach(async () => {
    github = fakeGitHub({
      'guidelines/perf.md': { sha: 'sha-1', content: EXPLICIT_ID_FILE('org.perf') },
      'guidelines/logging.md': { sha: 'sha-log', content: '- Emit JSON logs.' },
    })
    harness = makeService(github)
    const source = await harness.service.link('workspace', 'ws1', {
      repoOwner: 'acme',
      repoName: 'guidelines',
      dirPath: 'guidelines',
    })
    sourceId = source.id
    await harness.service.sync('workspace', 'ws1', sourceId)
  })

  it('keeps an explicit-id fragment live when its file is RENAMED', async () => {
    // Rename: same explicit frontmatter id, new path. A path-keyed sweep would
    // tombstone the row the rename just updated; the id-keyed sweep must not.
    delete github.files['guidelines/perf.md']
    github.files['guidelines/performance.md'] = {
      sha: 'sha-2',
      content: EXPLICIT_ID_FILE('org.perf'),
    }
    const result = await harness.service.sync('workspace', 'ws1', sourceId)
    expect(result.tombstoned).toBe(0)

    const row = await harness.fragments.get('workspace', 'ws1', 'org.perf')
    expect(row?.deletedAt).toBeNull()
    expect(row?.sourcePath).toBe('guidelines/performance.md')
  })

  it('retires the OLD id when a file changes its explicit frontmatter id in place', async () => {
    github.files['guidelines/perf.md'] = {
      sha: 'sha-2',
      content: EXPLICIT_ID_FILE('org.perf-v2'),
    }
    const result = await harness.service.sync('workspace', 'ws1', sourceId)
    expect(result.tombstoned).toBe(1)

    expect((await harness.fragments.get('workspace', 'ws1', 'org.perf'))?.deletedAt).not.toBeNull()
    expect((await harness.fragments.get('workspace', 'ws1', 'org.perf-v2'))?.deletedAt).toBeNull()
  })

  it('tombstones a fragment whose file was removed upstream', async () => {
    delete github.files['guidelines/logging.md']
    const result = await harness.service.sync('workspace', 'ws1', sourceId)
    expect(result.tombstoned).toBe(1)
    expect((await harness.fragments.get('workspace', 'ws1', 'org.perf'))?.deletedAt).toBeNull()
  })

  it('keeps the prior fragment when its changed file becomes unreadable this round', async () => {
    // The listing advertises a new sha but the content read 404s (transient) — the
    // prior fragment must survive rather than being retired over a blip.
    github.files['guidelines/perf.md']!.sha = 'sha-2'
    github.getFileContent = async () => null
    const result = await harness.service.sync('workspace', 'ws1', sourceId)
    expect(result.tombstoned).toBe(0)
    expect((await harness.fragments.get('workspace', 'ws1', 'org.perf'))?.deletedAt).toBeNull()
  })

  it('resolves the GitHub installation ONCE per sync, not per file', async () => {
    const counting = makeService(github)
    const source = await counting.service.link('workspace', 'ws1', {
      repoOwner: 'acme',
      repoName: 'guidelines',
      dirPath: 'guidelines',
    })
    await counting.service.sync('workspace', 'ws1', source.id)
    expect(counting.installations()).toBe(1)
  })
})
