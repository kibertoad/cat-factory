import { describe, expect, it } from 'vitest'
import type { DocsRepoReader } from './docs-detect.logic.js'
import { detectDocsLayout } from './docs-detect.logic.js'

// In-memory RepoFiles-shaped reader built from a flat path→content map. `listDirectory` derives
// the immediate children (file vs dir) from the keys, mirroring the contents API. A directory
// only "exists" when it has at least one descendant file. (Same fixture shape as
// `provision-detect.logic.test.ts`.)
function makeReader(files: Record<string, string>): DocsRepoReader {
  const paths = Object.keys(files)
  return {
    async getFile(path) {
      return path in files ? { content: files[path]! } : null
    },
    async listDirectory(path) {
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

// A reader that THROWS on every read (as the real GitHub/GitLab client does on any non-404 —
// auth/permission/rate-limit/transport), to prove the detector degrades to defaults rather than
// propagating — a prefill must never block create.
function makeThrowingReader(): DocsRepoReader {
  return {
    async getFile() {
      throw new Error('GitHub GET /contents → 403: forbidden')
    },
    async listDirectory() {
      throw new Error('GitHub GET /contents → 403: forbidden')
    },
  }
}

// Wraps a reader to count how many directory listings it performs (proves the bounded fan-out).
function countingReader(inner: DocsRepoReader): {
  reader: DocsRepoReader
  listCount: () => number
} {
  let lists = 0
  return {
    reader: {
      getFile: (p, r) => inner.getFile(p, r),
      listDirectory: (p, r) => {
        lists++
        return inner.listDirectory(p, r)
      },
    },
    listCount: () => lists,
  }
}

const DEFAULTS = {
  placementMode: 'root' as const,
  docsRoot: 'docs',
  diagramsDir: 'docs/diagrams',
  businessRulesDir: 'docs/business-logic',
  hasExistingMermaid: false,
  monorepo: false,
}

describe('detectDocsLayout — defaults & degradation', () => {
  it('returns the conventional defaults for an empty / undocumented repo', async () => {
    const rec = await detectDocsLayout(makeReader({ 'src/index.ts': 'x' }))
    expect(rec).toEqual(DEFAULTS)
  })

  it('never throws and yields defaults when the reader faults on every read', async () => {
    const rec = await detectDocsLayout(makeThrowingReader())
    expect(rec).toEqual(DEFAULTS)
  })
})

describe('detectDocsLayout — docs root', () => {
  it('detects a root `docs/` tree', async () => {
    const rec = await detectDocsLayout(makeReader({ 'docs/overview.md': '# hi', 'README.md': 'x' }))
    expect(rec.docsRoot).toBe('docs')
    expect(rec.placementMode).toBe('root')
    expect(rec.monorepo).toBe(false)
  })

  it('honours an alternative root docs dir name (`documentation`) and derives subfolders from it', async () => {
    const rec = await detectDocsLayout(makeReader({ 'documentation/overview.md': '# hi' }))
    expect(rec.docsRoot).toBe('documentation')
    // subfolders default UNDER the detected root, not a hardcoded `docs/`
    expect(rec.diagramsDir).toBe('documentation/diagrams')
    expect(rec.businessRulesDir).toBe('documentation/business-logic')
  })

  it('prefers `docs` over `doc`/`documentation` when several exist', async () => {
    const rec = await detectDocsLayout(
      makeReader({ 'doc/x.md': 'x', 'docs/y.md': 'y', 'documentation/z.md': 'z' }),
    )
    expect(rec.docsRoot).toBe('docs')
  })
})

describe('detectDocsLayout — known subfolders', () => {
  it('detects existing diagrams + business-rules subfolders under the docs root', async () => {
    const rec = await detectDocsLayout(
      makeReader({
        'docs/architecture/c4.md': 'x',
        'docs/domain/rules.md': 'y',
      }),
    )
    expect(rec.diagramsDir).toBe('docs/architecture')
    expect(rec.businessRulesDir).toBe('docs/domain')
  })

  it('prefers the most-conventional subfolder name when several match', async () => {
    const rec = await detectDocsLayout(
      makeReader({
        'docs/diagrams/a.md': 'x',
        'docs/architecture/b.md': 'x',
        'docs/business-logic/c.md': 'y',
        'docs/business/d.md': 'y',
      }),
    )
    expect(rec.diagramsDir).toBe('docs/diagrams')
    expect(rec.businessRulesDir).toBe('docs/business-logic')
  })

  it('falls back to defaults under the detected root when no known subfolder exists', async () => {
    const rec = await detectDocsLayout(makeReader({ 'docs/overview.md': '# hi' }))
    expect(rec.diagramsDir).toBe('docs/diagrams')
    expect(rec.businessRulesDir).toBe('docs/business-logic')
  })
})

describe('detectDocsLayout — existing mermaid', () => {
  it('flags a standalone `.mmd` file inside the docs root', async () => {
    const rec = await detectDocsLayout(makeReader({ 'docs/flow.mmd': 'graph TD' }))
    expect(rec.hasExistingMermaid).toBe(true)
  })

  it('flags a `mermaid` directory under the docs root', async () => {
    const rec = await detectDocsLayout(makeReader({ 'docs/mermaid/flow.txt': 'graph TD' }))
    expect(rec.hasExistingMermaid).toBe(true)
  })

  it('flags a mermaid source nested inside the detected diagrams subfolder', async () => {
    const rec = await detectDocsLayout(makeReader({ 'docs/diagrams/system.mermaid': 'graph TD' }))
    expect(rec.diagramsDir).toBe('docs/diagrams')
    expect(rec.hasExistingMermaid).toBe(true)
  })

  it('stays false when only prose docs exist (embedded fences are not read)', async () => {
    const rec = await detectDocsLayout(
      makeReader({ 'docs/overview.md': '```mermaid\ngraph TD\n```' }),
    )
    expect(rec.hasExistingMermaid).toBe(false)
  })
})

describe('detectDocsLayout — monorepo & placement mode', () => {
  it('flags a monorepo from a workspace manifest without switching to per-service on its own', async () => {
    const rec = await detectDocsLayout(
      makeReader({ 'pnpm-workspace.yaml': 'packages:\n  - packages/*', 'docs/overview.md': 'x' }),
    )
    expect(rec.monorepo).toBe(true)
    // manifest-only (no conventional package dir to sample) ⇒ stay with the safe `root` default
    expect(rec.placementMode).toBe('root')
  })

  it('detects a monorepo from a `workspaces` package.json field', async () => {
    const rec = await detectDocsLayout(
      makeReader({ 'package.json': JSON.stringify({ workspaces: ['packages/*'] }) }),
    )
    expect(rec.monorepo).toBe(true)
  })

  it('detects per-service placement when most sampled packages carry their own docs', async () => {
    const rec = await detectDocsLayout(
      makeReader({
        'pnpm-workspace.yaml': 'packages:\n  - packages/*',
        'packages/alpha/docs/readme.md': 'x',
        'packages/alpha/src/index.ts': 'x',
        'packages/beta/docs/readme.md': 'y',
        'packages/gamma/src/index.ts': 'z', // no docs
      }),
    )
    expect(rec.monorepo).toBe(true)
    expect(rec.placementMode).toBe('per-service') // 2 of 3 sampled ⇒ majority
  })

  it('stays root when a monorepo documents centrally (packages lack their own docs)', async () => {
    const rec = await detectDocsLayout(
      makeReader({
        'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
        'docs/overview.md': 'central',
        'packages/alpha/src/index.ts': 'x',
        'packages/beta/src/index.ts': 'y',
      }),
    )
    expect(rec.monorepo).toBe(true)
    expect(rec.placementMode).toBe('root')
  })

  it('samples across several workspace roots (apps/ + services/)', async () => {
    const rec = await detectDocsLayout(
      makeReader({
        'apps/web/docs/x.md': 'x',
        'apps/admin/docs/y.md': 'y',
        'services/api/docs/z.md': 'z',
      }),
    )
    expect(rec.monorepo).toBe(true) // present workspace dirs alone signal a monorepo
    expect(rec.placementMode).toBe('per-service')
  })
})

describe('detectDocsLayout — bounded fan-out', () => {
  it('caps package sampling (and total listings) on a huge monorepo', async () => {
    const files: Record<string, string> = { 'pnpm-workspace.yaml': 'packages:\n  - packages/*' }
    for (let i = 0; i < 200; i++) files[`packages/pkg-${i}/docs/readme.md`] = 'x'
    const { reader, listCount } = countingReader(makeReader(files))
    const rec = await detectDocsLayout(reader)
    expect(rec.placementMode).toBe('per-service')
    // root + docsRoot + packages + <=6 sampled package listings — nowhere near the 200 packages.
    expect(listCount()).toBeLessThanOrEqual(12)
  })
})
