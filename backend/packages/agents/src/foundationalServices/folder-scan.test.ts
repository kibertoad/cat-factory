import type { RepoContentEntry } from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_FOLDER_CONTRACT_FILE_BYTES,
  MAX_FOLDER_CONTRACT_FILES,
  MAX_FOLDER_SCAN_DEPTH,
  MAX_FOLDER_SCAN_DIRECTORIES,
  scanContractFolder,
} from './folder-scan.js'

/**
 * Build a `listDir` over a literal `path -> entry names` tree. A trailing `/` marks a dir.
 *
 * `sizes` is keyed by entry PATH and left undefined for everything it does not name, which is
 * the shape a host that omits sizes from its listings produces.
 */
function treeLister(tree: Record<string, string[]>, sizes: Record<string, number> = {}) {
  return vi.fn(
    async (path: string): Promise<RepoContentEntry[]> =>
      (tree[path] ?? []).map((name) => {
        const isDir = name.endsWith('/')
        const base = isDir ? name.slice(0, -1) : name
        const entryPath = path ? `${path}/${base}` : base
        return {
          path: entryPath,
          name: base,
          type: isDir ? 'dir' : 'file',
          sha: `sha-${base}`,
          size: sizes[entryPath],
        }
      }),
  )
}

describe('scanContractFolder', () => {
  it('takes only candidate files and never descends when not recursive', async () => {
    const listDir = treeLister({
      specs: ['README.md', 'logo.png', 'openapi.yaml', 'nested/'],
      'specs/nested': ['deep.yaml'],
    })
    const result = await scanContractFolder({ listDir, root: 'specs', recursive: false })

    expect(result.paths).toEqual(['specs/openapi.yaml'])
    expect(result.coverage).toBe('complete')
    // The subfolder is never listed at all — a non-recursive link costs exactly one read.
    expect(listDir).toHaveBeenCalledTimes(1)
  })

  it('descends into subfolders when asked, shallowest-first then by name', async () => {
    const listDir = treeLister({
      specs: ['v2/', 'v1/', 'root.yaml'],
      'specs/v1': ['users.json'],
      'specs/v2': ['users.json'],
    })
    const result = await scanContractFolder({ listDir, root: 'specs', recursive: true })

    expect(result.paths).toEqual(['specs/root.yaml', 'specs/v1/users.json', 'specs/v2/users.json'])
    expect(result.coverage).toBe('complete')
  })

  it('lifts a root service.md out of the contract set and reports it separately', async () => {
    const listDir = treeLister({
      specs: ['service.md', 'openapi.yaml', 'sub/'],
      'specs/sub': ['service.md', 'inner.yaml'],
    })
    const result = await scanContractFolder({ listDir, root: 'specs', recursive: true })

    expect(result.manifestPath).toBe('specs/service.md')
    // A NESTED service.md identifies nothing here (the link named the service), and it is not a
    // contract document either, so it simply never appears.
    expect(result.paths).toEqual(['specs/openapi.yaml', 'specs/sub/inner.yaml'])
  })

  it('reports no manifest when the folder has none', async () => {
    const listDir = treeLister({ specs: ['openapi.yaml'] })
    expect(
      (await scanContractFolder({ listDir, root: 'specs', recursive: true })).manifestPath,
    ).toBe(null)
  })

  it('says so when the depth cap stops the descent', async () => {
    // A chain one level deeper than the cap allows.
    const tree: Record<string, string[]> = {}
    let path = 'specs'
    for (let depth = 0; depth <= MAX_FOLDER_SCAN_DEPTH; depth++) {
      tree[path] = ['down/', `spec${depth}.yaml`]
      path = `${path}/down`
    }
    tree[path] = ['too-deep.yaml']

    const result = await scanContractFolder({
      listDir: treeLister(tree),
      root: 'specs',
      recursive: true,
    })

    expect(result.coverage).toBe('truncated')
    expect(result.paths).not.toContain(`${path}/too-deep.yaml`)
    expect(result.paths).toContain('specs/spec0.yaml')
  })

  it('says so when the file cap stops the walk, keeping the shallowest files', async () => {
    const names = Array.from({ length: MAX_FOLDER_CONTRACT_FILES + 5 }, (_, i) => `s${i}.yaml`)
    const listDir = treeLister({ specs: [...names, 'sub/'], 'specs/sub': ['nested.yaml'] })

    const result = await scanContractFolder({ listDir, root: 'specs', recursive: true })

    expect(result.paths).toHaveLength(MAX_FOLDER_CONTRACT_FILES)
    expect(result.coverage).toBe('truncated')
    expect(result.paths).not.toContain('specs/sub/nested.yaml')
  })

  it('says so when the directory cap stops the walk', async () => {
    // A wide root whose children each hold one spec: the walk runs out of listings, not files.
    const children = Array.from({ length: MAX_FOLDER_SCAN_DIRECTORIES + 10 }, (_, i) => `d${i}/`)
    const tree: Record<string, string[]> = { specs: children }
    for (const child of children) tree[`specs/${child.slice(0, -1)}`] = []

    const result = await scanContractFolder({
      listDir: treeLister(tree),
      root: 'specs',
      recursive: true,
    })

    expect(result.coverage).toBe('truncated')
  })

  it('keeps the walk order when a level’s listings answer out of order', async () => {
    // The listings within a level run concurrently, so the network decides who answers first.
    // Ordering must come from the walk, not from that race — otherwise a truncated scan would
    // keep a different set of contracts on every sync.
    const tree = treeLister({
      specs: ['z/', 'a/', 'm/'],
      'specs/a': ['a1.yaml'],
      'specs/m': ['m1.yaml'],
      'specs/z': ['z1.yaml'],
    })
    // Answer the alphabetically-first directory LAST, by the widest margin.
    const delays: Record<string, number> = { 'specs/a': 30, 'specs/m': 15, 'specs/z': 0 }
    const listDir = async (path: string) => {
      const entries = await tree(path)
      await new Promise((resolve) => setTimeout(resolve, delays[path] ?? 0))
      return entries
    }

    const result = await scanContractFolder({ listDir, root: 'specs', recursive: true })

    expect(result.paths).toEqual(['specs/a/a1.yaml', 'specs/m/m1.yaml', 'specs/z/z1.yaml'])
    expect(result.coverage).toBe('complete')
  })

  it('is deterministic across runs, so a truncated scan keeps the same contracts', async () => {
    const listDir = treeLister({
      specs: ['b.yaml', 'a.yaml', 'z/', 'm/'],
      'specs/m': ['m1.yaml'],
      'specs/z': ['z1.yaml'],
    })
    const first = await scanContractFolder({ listDir, root: 'specs', recursive: true })
    const second = await scanContractFolder({ listDir, root: 'specs', recursive: true })

    expect(first.paths).toEqual(second.paths)
    expect(first.paths).toEqual([
      'specs/a.yaml',
      'specs/b.yaml',
      'specs/m/m1.yaml',
      'specs/z/z1.yaml',
    ])
  })
})

// A folder that holds no contracts and a folder that is not there both produce zero paths, and
// the reconcile RETIRES a service over the first. Git cannot store an empty directory, so the
// empty root listing a host answers a missing path with is the only signal separating them.
describe('scanContractFolder — a folder that is not there', () => {
  it('reports a root that lists nothing as missing, not as an empty folder', async () => {
    const listDir = treeLister({})

    const result = await scanContractFolder({ listDir, root: 'specs/typo', recursive: true })

    expect(result.coverage).toBe('missing')
    expect(result.paths).toEqual([])
  })

  it('reports a folder holding only prose as complete', async () => {
    const listDir = treeLister({ specs: ['README.md'] })

    const result = await scanContractFolder({ listDir, root: 'specs', recursive: true })

    // The distinction the reconcile acts on: this folder EXISTS and holds no contracts, so the
    // service it feeds is genuinely obsolete; the one above may simply have moved.
    expect(result.coverage).toBe('complete')
    expect(result.paths).toEqual([])
  })

  it('does not mistake an empty SUBfolder for a missing root', async () => {
    const listDir = treeLister({ specs: ['openapi.yaml', 'empty/'], 'specs/empty': [] })

    const result = await scanContractFolder({ listDir, root: 'specs', recursive: true })

    expect(result.coverage).toBe('complete')
    expect(result.paths).toEqual(['specs/openapi.yaml'])
  })
})

describe('scanContractFolder — the file-size cap', () => {
  it('declines a candidate too large to read and counts it as skipped', async () => {
    const listDir = treeLister(
      { specs: ['huge.json', 'small.yaml'] },
      { 'specs/huge.json': MAX_FOLDER_CONTRACT_FILE_BYTES + 1 },
    )

    const result = await scanContractFolder({ listDir, root: 'specs', recursive: false })

    // Declined without a read — above this size the host answers with an empty body anyway, so
    // fetching it could only ever cost a round trip and produce the same skip.
    expect(result.paths).toEqual(['specs/small.yaml'])
    expect(result.skippedCandidates).toBe(1)
    // A cap that dropped a file is never silent, but it is not TRUNCATION either: we know
    // exactly what was dropped, where truncation means we do not know what we missed.
    expect(result.coverage).toBe('complete')
  })

  it('reads a candidate whose size the listing does not carry', async () => {
    const listDir = treeLister({ specs: ['openapi.yaml'] })

    const result = await scanContractFolder({ listDir, root: 'specs', recursive: false })

    // Declining on an ABSENT size would silently drop every contract on a host whose listings
    // omit it. An oversized body then reads back empty and is skipped at the read instead.
    expect(result.paths).toEqual(['specs/openapi.yaml'])
    expect(result.skippedCandidates).toBe(0)
  })
})
