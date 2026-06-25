import type { CommitFilesInput } from '@cat-factory/contracts'
import type { AgentRunContext, RepoContentEntry, RepoFiles } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { blueprintPostOp } from './builtin.js'

// The built-in blueprint post-op: the deterministic render + commit lifted out of the
// executor-harness, exercised over an in-memory {@link RepoFiles}. Asserts the three
// behaviours that matter for a committing post-op run inside `recordStepResult`: it
// renders the artifact on a fresh repo, is a no-op on an unchanged tree (REPLAY-safe),
// and prunes a removed module's stale deep-dive file via the deletion channel.

/** A tiny in-memory RepoFiles that APPLIES commits, so idempotency can be tested end-to-end. */
class FakeRepo implements RepoFiles {
  readonly commits: CommitFilesInput[] = []
  constructor(private readonly fileMap: Map<string, string> = new Map()) {}

  async getFile(path: string) {
    const content = this.fileMap.get(path)
    return content === undefined ? null : { content, sha: 'sha' }
  }

  async listDirectory(path: string): Promise<RepoContentEntry[]> {
    const prefix = `${path.replace(/\/+$/, '')}/`
    const files = new Set<string>()
    const dirs = new Set<string>()
    for (const p of this.fileMap.keys()) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash === -1) files.add(p)
      else dirs.add(`${prefix}${rest.slice(0, slash)}`)
    }
    return [
      ...[...files].map((p) => ({ path: p, name: p.split('/').pop()!, type: 'file', sha: 'sha' })),
      ...[...dirs].map((p) => ({ path: p, name: p.split('/').pop()!, type: 'dir', sha: 'sha' })),
    ]
  }

  async headSha() {
    return 'head'
  }
  async createBranch() {}

  async commitFiles(input: CommitFilesInput) {
    this.commits.push(input)
    for (const f of input.files) this.fileMap.set(f.path, f.content)
    for (const d of input.deletions ?? []) this.fileMap.delete(d)
    return { sha: 'commit' }
  }

  async openPullRequest(): Promise<never> {
    throw new Error('not used')
  }
}

const ctx = (repo: RepoFiles, blueprintService: unknown) => ({
  repo,
  branch: 'main',
  context: {} as AgentRunContext,
  result: { output: '', blueprintService },
})

const TREE = {
  name: 'Widgets',
  summary: 'A widget service.',
  modules: [
    { name: 'Billing', summary: 'Invoices', references: ['src/billing.ts'] },
    { name: 'Catalog', summary: 'Products', references: [] },
  ],
}

describe('blueprintPostOp', () => {
  it('renders + commits the blueprint artifact on a fresh repo', async () => {
    const repo = new FakeRepo()
    await blueprintPostOp(ctx(repo, TREE))

    expect(repo.commits).toHaveLength(1)
    const paths = repo.commits[0]!.files.map((f) => f.path).sort()
    expect(paths).toEqual([
      'blueprints/blueprint.json',
      'blueprints/modules/billing.md',
      'blueprints/modules/catalog.md',
      'blueprints/overview.md',
      'blueprints/version.json',
    ])
    expect(repo.commits[0]!.deletions ?? []).toEqual([])
    const version = JSON.parse(
      repo.commits[0]!.files.find((f) => f.path === 'blueprints/version.json')!.content,
    )
    expect(version.version).toBe(1)
    expect(version.modules).toBe(2)
  })

  it('is a no-op when the tree is unchanged (replay-safe)', async () => {
    const repo = new FakeRepo()
    await blueprintPostOp(ctx(repo, TREE)) // first run commits
    await blueprintPostOp(ctx(repo, TREE)) // replay: identical hash ⇒ no commit
    expect(repo.commits).toHaveLength(1)
  })

  it('prunes a removed module’s stale deep-dive file', async () => {
    const repo = new FakeRepo()
    await blueprintPostOp(ctx(repo, TREE)) // billing + catalog
    // Re-run with Catalog dropped: its deep-dive must be deleted, version bumped.
    await blueprintPostOp(ctx(repo, { ...TREE, modules: [TREE.modules[0]] }))

    expect(repo.commits).toHaveLength(2)
    expect(repo.commits[1]!.deletions).toEqual(['blueprints/modules/catalog.md'])
    const version = JSON.parse(
      repo.commits[1]!.files.find((f) => f.path === 'blueprints/version.json')!.content,
    )
    expect(version.version).toBe(2)
  })

  it('commits nothing for a nameless / unusable tree', async () => {
    const repo = new FakeRepo()
    await blueprintPostOp(ctx(repo, { modules: [] }))
    expect(repo.commits).toHaveLength(0)
  })
})
