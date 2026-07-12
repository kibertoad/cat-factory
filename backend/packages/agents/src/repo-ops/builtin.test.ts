import type { CommitFilesInput } from '@cat-factory/contracts'
import type { AgentRunContext, RepoContentEntry, RepoFiles } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { blueprintPostOp, specPostOp } from './builtin.js'

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
  async deleteBranch() {}

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

// The built-in spec post-op: the deterministic SHARD + commit lifted out of the harness
// `/spec` handler, exercised over the same in-memory {@link RepoFiles}. Asserts the
// reconcile rules that matter when it runs inside `recordStepResult`: it shards the artifact
// on a fresh repo (incl. seed feature files), is a no-op on an unchanged doc (REPLAY-safe),
// SEEDS-ONCE the Gherkin files (never clobbering a polished one), PRUNES a removed group's
// canonical shards, and drops the pre-sharding monolithic artifacts.

const specCtx = (repo: RepoFiles, spec: unknown) => ({
  repo,
  branch: 'cat-factory/task_login',
  context: {} as AgentRunContext,
  result: { output: '', spec },
})

const SPEC = {
  service: 'Widgets',
  summary: 'A widget service.',
  modules: [
    {
      name: 'Auth',
      summary: 'Authentication',
      groups: [
        {
          name: 'Login',
          summary: 'Signing in',
          requirements: [
            {
              title: 'Password login',
              statement: 'The system SHALL authenticate a user by password.',
              kind: 'functional',
              priority: 'must',
              acceptance: [
                { given: 'a valid user', when: 'they sign in', outcome: 'a session opens' },
              ],
            },
          ],
          rules: [],
        },
      ],
    },
    {
      name: 'Billing',
      summary: 'Invoicing',
      groups: [
        {
          name: 'Invoices',
          summary: 'Issuing invoices',
          requirements: [
            {
              title: 'Issue invoice',
              statement: 'The system SHALL issue an invoice on order completion.',
              kind: 'functional',
              priority: 'should',
              acceptance: [
                { given: 'a completed order', when: 'it closes', outcome: 'an invoice is issued' },
              ],
            },
          ],
          rules: [],
        },
      ],
    },
  ],
}

describe('specPostOp', () => {
  it('shards + commits the spec artifact (incl. seed feature files) on a fresh repo', async () => {
    const repo = new FakeRepo()
    await specPostOp(specCtx(repo, SPEC))

    expect(repo.commits).toHaveLength(1)
    const paths = repo.commits[0]!.files.map((f) => f.path).sort()
    expect(paths).toEqual([
      'spec/features/auth/login.feature',
      'spec/features/billing/invoices.feature',
      'spec/modules/auth/_module.json',
      'spec/modules/auth/login.json',
      'spec/modules/auth/login.md',
      'spec/modules/billing/_module.json',
      'spec/modules/billing/invoices.json',
      'spec/modules/billing/invoices.md',
      'spec/overview.md',
      'spec/service.json',
    ])
    expect(repo.commits[0]!.deletions ?? []).toEqual([])
  })

  it('is a no-op when the doc is unchanged (replay-safe)', async () => {
    const repo = new FakeRepo()
    await specPostOp(specCtx(repo, SPEC)) // first run commits
    await specPostOp(specCtx(repo, SPEC)) // replay: identical shards, nothing seeded/pruned ⇒ no commit
    expect(repo.commits).toHaveLength(1)
  })

  it('seeds Gherkin files once — never clobbering a polished one', async () => {
    const repo = new FakeRepo(
      new Map([['spec/features/auth/login.feature', 'Feature: hand-polished — keep me\n']]),
    )
    await specPostOp(specCtx(repo, SPEC))
    // The existing login.feature is left untouched; only the absent billing one is seeded.
    const committed = repo.commits[0]!.files.map((f) => f.path)
    expect(committed).toContain('spec/features/billing/invoices.feature')
    expect(committed).not.toContain('spec/features/auth/login.feature')
  })

  it('prunes a removed group’s canonical shards', async () => {
    const repo = new FakeRepo()
    await specPostOp(specCtx(repo, SPEC)) // auth + billing
    // Re-run with Billing dropped: its module shards must be deleted.
    await specPostOp(specCtx(repo, { ...SPEC, modules: [SPEC.modules[0]] }))

    expect(repo.commits).toHaveLength(2)
    expect(repo.commits[1]!.deletions?.sort()).toEqual([
      'spec/modules/billing/_module.json',
      'spec/modules/billing/invoices.json',
      'spec/modules/billing/invoices.md',
    ])
  })

  it('drops the pre-sharding monolithic artifacts on sight', async () => {
    const repo = new FakeRepo(
      new Map([
        ['spec/spec.json', '{"old":true}'],
        ['spec/rules.md', '# old rules'],
        ['spec/version.json', '{"version":1}'],
        ['spec/features/flat.feature', 'Feature: legacy flat\n'],
      ]),
    )
    await specPostOp(specCtx(repo, SPEC))
    expect(repo.commits[0]!.deletions?.sort()).toEqual([
      'spec/features/flat.feature',
      'spec/rules.md',
      'spec/spec.json',
      'spec/version.json',
    ])
  })

  it('commits nothing for a nameless / unusable doc', async () => {
    const repo = new FakeRepo()
    await specPostOp(specCtx(repo, { modules: [] }))
    expect(repo.commits).toHaveLength(0)
  })
})
