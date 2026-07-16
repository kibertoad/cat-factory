import type {
  AccountSkillRecord,
  AccountSkillRepository,
  GitHubClient,
  RepoContentEntry,
  SkillSourceRecord,
  SkillSourceRepository,
} from '@cat-factory/kernel'
import { beforeEach, describe, expect, it } from 'vitest'
import { SkillSourceService } from './SkillSourceService.js'

// Pure-logic coverage for the skill repo-source resync: the directory-per-skill sync
// unit, the commit-moved short-circuit, the resource-only-change path (which advances
// the dir head without touching SKILL.md's blob sha), the id-keyed tombstone sweep, and
// keeping a prior skill alive over a transient manifest read failure.

interface FileEntry {
  sha: string
  content: string
  size?: number
}

class FakeAccountSkillRepo implements AccountSkillRepository {
  readonly rows = new Map<string, AccountSkillRecord>()
  private key(a: string, s: string) {
    return `${a}|${s}`
  }
  async listByAccount(accountId: string, includeDeleted = false) {
    return [...this.rows.values()].filter(
      (r) => r.accountId === accountId && (includeDeleted || r.deletedAt === null),
    )
  }
  async get(accountId: string, skillId: string) {
    return this.rows.get(this.key(accountId, skillId)) ?? null
  }
  async upsert(record: AccountSkillRecord) {
    this.rows.set(this.key(record.accountId, record.skillId), { ...record })
  }
  async softDelete(accountId: string, skillId: string, at: number) {
    const r = this.rows.get(this.key(accountId, skillId))
    if (r) r.deletedAt = at
  }
  async listBySource(sourceId: string) {
    return [...this.rows.values()].filter((r) => r.sourceId === sourceId && r.deletedAt === null)
  }
}

class FakeSkillSourceRepo implements SkillSourceRepository {
  readonly rows = new Map<string, SkillSourceRecord>()
  async listByAccount(accountId: string) {
    return [...this.rows.values()].filter((r) => r.accountId === accountId && r.deletedAt === null)
  }
  async get(id: string) {
    return this.rows.get(id) ?? null
  }
  async upsert(record: SkillSourceRecord) {
    this.rows.set(record.id, { ...record })
  }
  async updateSyncState(id: string, lastSyncedCommit: string | null, lastSyncedAt: number) {
    const r = this.rows.get(id)
    if (r) Object.assign(r, { lastSyncedCommit, lastSyncedAt })
  }
  async softDelete(id: string, at: number) {
    const r = this.rows.get(id)
    if (r) r.deletedAt = at
  }
}

/**
 * A GitHub fake serving an in-memory `files` map (full path → sha/content). Directory
 * listings are derived from the path structure; `latestCommitSha(dir)` is a digest of
 * every file under `dir`, so any change (manifest OR resource) advances it.
 */
function fakeGitHub(files: Record<string, FileEntry>) {
  const unreadable = new Set<string>()
  const listDirectory = async (
    _i: number,
    _r: unknown,
    path: string,
  ): Promise<RepoContentEntry[]> => {
    const prefix = path ? `${path}/` : ''
    const childDirs = new Set<string>()
    const childFiles: RepoContentEntry[] = []
    for (const [full, f] of Object.entries(files)) {
      if (!full.startsWith(prefix)) continue
      const rest = full.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash === -1) {
        childFiles.push({ path: full, name: rest, type: 'file', sha: f.sha, size: f.size })
      } else {
        childDirs.add(rest.slice(0, slash))
      }
    }
    return [
      ...[...childDirs].map((d) => ({
        path: `${prefix}${d}`,
        name: d,
        type: 'dir',
        sha: `tree-${prefix}${d}`,
      })),
      ...childFiles,
    ]
  }
  return {
    files,
    unreadable,
    listDirectory,
    getFileContent: async (_i: number, _r: unknown, path: string) => {
      if (unreadable.has(path)) return null
      const f = files[path]
      return f ? { content: f.content, sha: f.sha } : null
    },
    latestCommitSha: async (_i: number, _r: unknown, dir: string) => {
      const prefix = dir ? `${dir}/` : ''
      const parts = Object.entries(files)
        .filter(([p]) => p.startsWith(prefix))
        .map(([p, f]) => `${p}:${f.sha}`)
        .sort()
      return parts.length ? `commit:${parts.join('|')}` : null
    },
  }
}

const manifest = (name: string, body: string) =>
  ['---', `name: ${name}`, `description: ${name} skill`, '---', '', body].join('\n')

function makeService(github: ReturnType<typeof fakeGitHub>) {
  const skills = new FakeAccountSkillRepo()
  const sources = new FakeSkillSourceRepo()
  let seq = 0
  const invalidations: string[] = []
  const service = new SkillSourceService({
    skillSourceRepository: sources,
    accountSkillRepository: skills,
    githubClient: github as unknown as GitHubClient,
    resolveInstallationId: async () => 42,
    idGenerator: { next: (p?: string) => `${p ?? 'id'}_${++seq}` },
    clock: { now: () => 1_000_000 + seq++ },
    invalidateCatalog: async (accountId) => {
      invalidations.push(accountId)
    },
  })
  return { service, skills, invalidations }
}

describe('SkillSourceService.sync', () => {
  let github: ReturnType<typeof fakeGitHub>
  let harness: ReturnType<typeof makeService>
  let sourceId: string

  beforeEach(async () => {
    github = fakeGitHub({
      '.claude/skills/triage/SKILL.md': { sha: 'm1', content: manifest('Triage', '- Reproduce') },
      '.claude/skills/triage/checklist.md': { sha: 'r1', content: 'steps', size: 5 },
      '.claude/skills/writer/SKILL.md': { sha: 'm2', content: manifest('Writer', '- Draft') },
    })
    harness = makeService(github)
    const source = await harness.service.link('acct1', {
      repoOwner: 'acme',
      repoName: 'repo',
      dirPath: '.claude/skills',
    })
    sourceId = source.id
    await harness.service.sync('acct1', sourceId)
  })

  it('imports one skill per SKILL.md directory, with its resource manifest', async () => {
    const rows = await harness.skills.listByAccount('acct1')
    expect(rows.map((r) => r.skillId).sort()).toEqual([
      `src:${sourceId}:triage`,
      `src:${sourceId}:writer`,
    ])
    const triage = rows.find((r) => r.skillId === `src:${sourceId}:triage`)!
    expect(triage.name).toBe('Triage')
    expect(triage.instructions).toBe('- Reproduce')
    expect(triage.resources).toEqual([
      { path: '.claude/skills/triage/checklist.md', sha: 'r1', size: 5 },
    ])
    expect(triage.pinnedCommit).not.toBeNull()
    expect(harness.invalidations).toHaveLength(1)
  })

  it('is a no-op on a resync with no upstream change (no invalidation)', async () => {
    const result = await harness.service.sync('acct1', sourceId)
    expect(result).toMatchObject({ upserted: 0, tombstoned: 0, unchanged: 2 })
    expect(harness.invalidations).toHaveLength(1) // still just the initial sync
  })

  it('refreshes the resource manifest on a resource-only change without re-reading SKILL.md', async () => {
    // A resource edit advances the dir head commit but leaves SKILL.md's blob sha alone.
    github.files['.claude/skills/triage/checklist.md'] = { sha: 'r2', content: 'more', size: 9 }
    const result = await harness.service.sync('acct1', sourceId)
    expect(result.upserted).toBe(1)
    const triage = await harness.skills.get('acct1', `src:${sourceId}:triage`)
    expect(triage?.resources).toEqual([
      { path: '.claude/skills/triage/checklist.md', sha: 'r2', size: 9 },
    ])
    expect(triage?.sourceSha).toBe('m1') // manifest unchanged
    expect(harness.invalidations).toHaveLength(2)
  })

  it('tombstones a skill whose directory is removed upstream', async () => {
    delete github.files['.claude/skills/writer/SKILL.md']
    const result = await harness.service.sync('acct1', sourceId)
    expect(result.tombstoned).toBe(1)
    expect((await harness.skills.listByAccount('acct1')).map((r) => r.skillId)).toEqual([
      `src:${sourceId}:triage`,
    ])
  })

  it('treats a renamed directory as a new identity (old id tombstoned)', async () => {
    const body = manifest('Writer', '- Draft')
    delete github.files['.claude/skills/writer/SKILL.md']
    github.files['.claude/skills/authoring/SKILL.md'] = { sha: 'm2', content: body }
    const result = await harness.service.sync('acct1', sourceId)
    expect(result.upserted).toBe(1)
    expect(result.tombstoned).toBe(1)
    const live = (await harness.skills.listByAccount('acct1')).map((r) => r.skillId).sort()
    expect(live).toEqual([`src:${sourceId}:authoring`, `src:${sourceId}:triage`])
  })

  it('keeps a prior skill alive when its manifest becomes transiently unreadable', async () => {
    // Bump the manifest sha (so the fast path misses) but make the body unreadable.
    github.files['.claude/skills/triage/SKILL.md'] = {
      sha: 'm1b',
      content: manifest('Triage', 'x'),
    }
    github.unreadable.add('.claude/skills/triage/SKILL.md')
    const result = await harness.service.sync('acct1', sourceId)
    expect(result.tombstoned).toBe(0)
    const triage = await harness.skills.get('acct1', `src:${sourceId}:triage`)
    expect(triage).not.toBeNull()
    expect(triage?.instructions).toBe('- Reproduce') // prior content preserved
  })

  it('reports changed=true from status when the source dir moved', async () => {
    let status = await harness.service.status('acct1', sourceId)
    expect(status.changed).toBe(false)
    github.files['.claude/skills/writer/SKILL.md'] = {
      sha: 'm2b',
      content: manifest('Writer', 'y'),
    }
    status = await harness.service.status('acct1', sourceId)
    expect(status.changed).toBe(true)
  })
})
