import { describe, expect, it } from 'vitest'
import type { CheckoutFreeRepoReader } from './repo-scan.logic.js'
import { BudgetedRepoScanner, joinRepoPath } from './repo-scan.logic.js'

// In-memory reader built from a flat path→content map, mirroring the contents API: `listDirectory`
// derives immediate children (file vs dir) from the keys. Optionally records the git ref each call
// was made at, so a test can assert the scanner threads its constructor `gitRef` through.
function makeReader(
  files: Record<string, string>,
  onRef?: (ref: string | undefined) => void,
): CheckoutFreeRepoReader {
  const paths = Object.keys(files)
  return {
    async getFile(path, gitRef) {
      onRef?.(gitRef)
      return path in files ? { content: files[path]! } : null
    },
    async listDirectory(path, gitRef) {
      onRef?.(gitRef)
      const prefix = path ? `${path}/` : ''
      const children = new Map<string, 'file' | 'dir'>()
      for (const full of paths) {
        if (!full.startsWith(prefix)) continue
        const rest = full.slice(prefix.length)
        if (!rest) continue
        const slash = rest.indexOf('/')
        if (slash === -1) children.set(rest, 'file')
        else children.set(rest.slice(0, slash), 'dir')
      }
      return [...children].map(([name, type]) => ({ name, type, path: prefix + name }))
    },
  }
}

describe('joinRepoPath', () => {
  it('joins, drops empties, collapses `.`, and resolves `..`', () => {
    expect(joinRepoPath('docs', 'diagrams')).toBe('docs/diagrams')
    expect(joinRepoPath('', 'a', undefined, 'b')).toBe('a/b')
    expect(joinRepoPath('a/./b')).toBe('a/b')
    expect(joinRepoPath('a/b', '../c')).toBe('a/c')
    expect(joinRepoPath()).toBe('')
  })
})

describe('BudgetedRepoScanner', () => {
  it('memoizes reads (a repeated path spends the budget only once)', async () => {
    let reads = 0
    const reader: CheckoutFreeRepoReader = {
      async getFile() {
        reads++
        return { content: 'x' }
      },
      async listDirectory() {
        return []
      },
    }
    const scanner = new BudgetedRepoScanner(reader, 10)
    await scanner.getFile('a.txt')
    await scanner.getFile('a.txt')
    await scanner.exists('a.txt')
    expect(reads).toBe(1)
  })

  it('stops at the budget and reports `exhausted` only when a read is actually skipped', async () => {
    const scanner = new BudgetedRepoScanner(makeReader({ a: '1', b: '2', c: '3' }), 2)
    expect(await scanner.getFile('a')).toBe('1')
    expect(await scanner.getFile('b')).toBe('2')
    expect(scanner.exhausted).toBe(false) // spent exactly the budget, nothing skipped yet
    expect(await scanner.getFile('c')).toBeNull() // skipped — over budget
    expect(scanner.exhausted).toBe(true)
  })

  it('getFirstFile returns the first present file and its matched name', async () => {
    const scanner = new BudgetedRepoScanner(
      makeReader({ 'dir/Chart.yaml': 'x', 'dir/other.txt': 'y' }),
      10,
    )
    expect(await scanner.getFirstFile('dir', ['Chart.yml', 'Chart.yaml'])).toEqual({
      name: 'Chart.yaml',
      content: 'x',
    })
    expect(await scanner.getFirstFile('dir', ['missing.yml'])).toBeNull()
  })

  it('swallows read faults but records the first one on `readFault`', async () => {
    const scanner = new BudgetedRepoScanner(
      {
        async getFile() {
          throw new Error('GitHub GET /contents → 403: forbidden')
        },
        async listDirectory() {
          throw new Error('later fault — not recorded, the first wins')
        },
      },
      10,
    )
    expect(await scanner.getFile('a')).toBeNull() // does not throw
    expect(await scanner.listDir('b')).toEqual([]) // does not throw
    expect(scanner.readFault).toBe('GitHub GET /contents → 403: forbidden')
  })

  it('threads its constructor `gitRef` through to the reader', async () => {
    const refs: (string | undefined)[] = []
    const scanner = new BudgetedRepoScanner(
      makeReader({ a: '1' }, (r) => refs.push(r)),
      10,
      'v2',
    )
    await scanner.getFile('a')
    await scanner.listDir('')
    expect(refs).toEqual(['v2', 'v2'])
  })

  it('tolerates a reader without `listDirectory` (a file-only reader)', async () => {
    const scanner = new BudgetedRepoScanner(
      {
        async getFile() {
          return { content: 'x' }
        },
      },
      10,
    )
    expect(await scanner.listDir('anything')).toEqual([])
    expect(await scanner.getFile('a')).toBe('x')
  })
})
