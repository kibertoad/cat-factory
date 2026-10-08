import type { GitHubChangedFile, RepoFiles } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { PrExplorer } from './PrExplorer.js'

const HEAD = 'head123'
const BASE = 'main'

/** A RepoFiles over two refs, recording every ref it was asked to read at. */
function repoFiles(files: Record<string, Record<string, string>>): {
  repo: RepoFiles
  refs: (string | undefined)[]
} {
  const refs: (string | undefined)[] = []
  const repo = {
    async getFile(path: string, gitRef?: string) {
      refs.push(gitRef)
      const content = files[gitRef ?? '']?.[path]
      return content === undefined ? null : { content, sha: 'sha' }
    },
    async listDirectory(path: string, gitRef?: string) {
      refs.push(gitRef)
      return path === 'src'
        ? [
            { path: 'src/pay.ts', name: 'pay.ts', type: 'file', sha: 'a' },
            { path: 'src/util', name: 'util', type: 'dir', sha: 'b' },
          ]
        : []
    },
  } as unknown as RepoFiles
  return { repo, refs }
}

const changed: GitHubChangedFile[] = [
  {
    path: 'src/pay.ts',
    previousPath: null,
    status: 'modified',
    additions: 2,
    deletions: 1,
    patch: '@@ -1 +1,2 @@\n-a\n+b\n+c',
  },
  {
    path: 'logo.png',
    previousPath: null,
    status: 'added',
    additions: null,
    deletions: null,
    patch: null,
  },
]

describe('PrExplorer', () => {
  it('reads the head at the reviewed commit and the base on the target branch', async () => {
    const { repo, refs } = repoFiles({
      [HEAD]: { 'src/pay.ts': 'one\ntwo\nthree' },
      [BASE]: { 'src/pay.ts': 'one' },
    })
    const explorer = new PrExplorer(repo, { headSha: HEAD, baseRef: BASE }, changed)
    expect(await explorer.readFile({ path: './src/pay.ts', side: 'head', startLine: 2 })).toBe(
      '`src/pay.ts` lines 2-3 of 3\n2: two\n3: three',
    )
    expect(await explorer.readFile({ path: 'src/pay.ts', side: 'base' })).toBe(
      '`src/pay.ts` lines 1-1 of 1\n1: one',
    )
    expect(refs).toEqual([HEAD, BASE])
  })

  it('truncates a long read and says where to resume', async () => {
    const body = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n')
    const { repo } = repoFiles({ [HEAD]: { 'big.ts': body } })
    const explorer = new PrExplorer(repo, { headSha: HEAD, baseRef: BASE }, changed, {
      maxReads: 10,
      maxFileLines: 3,
      maxChars: 10_000,
    })
    expect(await explorer.readFile({ path: 'big.ts', side: 'head' })).toBe(
      '`big.ts` lines 1-3 of 10\n1: l1\n2: l2\n3: l3\n(Truncated at 3 lines; read from line 4 for more.)',
    )
  })

  it('states why a read returned nothing instead of failing', async () => {
    const { repo } = repoFiles({})
    const explorer = new PrExplorer(repo, { headSha: HEAD, baseRef: BASE }, changed)
    expect(await explorer.readFile({ path: 'gone.ts', side: 'base' })).toBe(
      'There is no file `gone.ts` on the target branch `main`.',
    )
    expect(await explorer.readDiff('logo.png')).toContain('returned no patch')
    expect(await explorer.readDiff('elsewhere.ts')).toBe(
      '`elsewhere.ts` is not a file this pull request changes.',
    )
  })

  it('scrubs secrets from what it hands the model', async () => {
    const { repo } = repoFiles({
      [HEAD]: { '.env': 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
    })
    const explorer = new PrExplorer(repo, { headSha: HEAD, baseRef: BASE }, changed)
    expect(await explorer.readFile({ path: '.env', side: 'head' })).not.toContain(
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    )
  })

  it('stops reading once the budget is spent and says so', async () => {
    const { repo } = repoFiles({ [HEAD]: { 'a.ts': 'a' } })
    const explorer = new PrExplorer(repo, { headSha: HEAD, baseRef: BASE }, changed, {
      maxReads: 2,
      maxFileLines: 100,
      maxChars: 10_000,
    })
    await explorer.listChangedFiles()
    expect(await explorer.listDirectory('src')).toBe('file src/pay.ts\ndir  src/util')
    expect(await explorer.readFile({ path: 'a.ts', side: 'head' })).toContain(
      'read budget for this reply is spent',
    )
    expect(explorer.readsUsed).toBe(2)
  })
})
