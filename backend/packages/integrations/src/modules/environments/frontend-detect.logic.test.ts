import { describe, expect, it } from 'vitest'
import type { FrontendRepoReader } from './frontend-detect.logic.js'
import { detectFrontendConfig } from './frontend-detect.logic.js'

// In-memory RepoFiles-shaped reader built from a flat path→content map. `listDirectory`
// derives the immediate children (file vs dir) from the keys, mirroring the contents API.
function makeReader(files: Record<string, string>): FrontendRepoReader {
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

const pkg = (extra: Record<string, unknown>) => JSON.stringify(extra)

describe('detectFrontendConfig', () => {
  it('detects pnpm + Vite dist + build script (all high confidence)', async () => {
    const reader = makeReader({
      'pnpm-lock.yaml': 'lockfileVersion: 9',
      'package.json': pkg({ scripts: { build: 'vite build' }, devDependencies: { vite: '^5' } }),
      'vite.config.ts': 'export default {}',
    })
    const rec = await detectFrontendConfig(reader)
    expect(rec.detected).toBe(true)
    expect(rec.config.packageManager).toBe('pnpm')
    expect(rec.config.installCommand).toBe('pnpm install --frozen-lockfile')
    expect(rec.config.buildScript).toBe('build')
    expect(rec.config.outputDir).toBe('dist')
    expect(rec.config.serveMode).toBe('static')
    expect(rec.notes.find((n) => n.field === 'packageManager')?.confidence).toBe('high')
  })

  it('detects npm from package-lock.json (npm ci)', async () => {
    const reader = makeReader({
      'package-lock.json': '{}',
      'package.json': pkg({ scripts: { build: 'vite build' } }),
    })
    const rec = await detectFrontendConfig(reader)
    expect(rec.config.packageManager).toBe('npm')
    expect(rec.config.installCommand).toBe('npm ci')
  })

  it('detects yarn from yarn.lock', async () => {
    const reader = makeReader({
      'yarn.lock': '# yarn',
      'package.json': pkg({ scripts: { build: 'vite build' } }),
    })
    const rec = await detectFrontendConfig(reader)
    expect(rec.config.packageManager).toBe('yarn')
    expect(rec.config.installCommand).toBe('yarn install --frozen-lockfile')
  })

  it('flags Nuxt output dir as low confidence', async () => {
    const reader = makeReader({
      'pnpm-lock.yaml': 'x',
      'package.json': pkg({
        scripts: { build: 'nuxt build', generate: 'nuxt generate' },
        dependencies: { nuxt: '^3' },
      }),
    })
    const rec = await detectFrontendConfig(reader)
    expect(rec.config.outputDir).toBe('.output/public')
    expect(rec.notes.find((n) => n.field === 'outputDir')?.confidence).toBe('low')
  })

  it('flags Next output dir (out) as low confidence', async () => {
    const reader = makeReader({
      'pnpm-lock.yaml': 'x',
      'package.json': pkg({ scripts: { build: 'next build' }, dependencies: { next: '^14' } }),
    })
    const rec = await detectFrontendConfig(reader)
    expect(rec.config.outputDir).toBe('out')
    expect(rec.notes.find((n) => n.field === 'outputDir')?.confidence).toBe('low')
  })

  it('proposes command serve mode when a preview script exists', async () => {
    const reader = makeReader({
      'pnpm-lock.yaml': 'x',
      'package.json': pkg({
        scripts: { build: 'vite build', preview: 'vite preview' },
        devDependencies: { vite: '^5' },
      }),
    })
    const rec = await detectFrontendConfig(reader)
    expect(rec.config.serveMode).toBe('command')
    expect(rec.config.serveScript).toBe('preview')
  })

  it('does NOT treat a dev script as a serve script', async () => {
    const reader = makeReader({
      'pnpm-lock.yaml': 'x',
      'package.json': pkg({
        scripts: { build: 'vite build', dev: 'vite' },
        devDependencies: { vite: '^5' },
      }),
    })
    const rec = await detectFrontendConfig(reader)
    expect(rec.config.serveMode).toBe('static')
    expect(rec.config.serveScript).toBeUndefined()
  })

  it('extracts backend URL env vars from .env.example as mock bindings', async () => {
    const reader = makeReader({
      'pnpm-lock.yaml': 'x',
      'package.json': pkg({ scripts: { build: 'vite build' }, devDependencies: { vite: '^5' } }),
      '.env.example':
        'VITE_API_BASE_URL=http://localhost:3000\nSOME_SECRET=xyz\nVITE_BACKEND_URL=\n',
    })
    const rec = await detectFrontendConfig(reader)
    const envVars = rec.config.backendBindings.map((b) => b.envVar).sort()
    expect(envVars).toEqual(['VITE_API_BASE_URL', 'VITE_BACKEND_URL'])
    expect(rec.config.backendBindings.every((b) => b.source.kind === 'mock')).toBe(true)
  })

  it('roots detection at the frontend subdirectory', async () => {
    const reader = makeReader({
      // Repo root is a pnpm workspace with no frontend markers.
      'package.json': pkg({ name: 'monorepo' }),
      'pnpm-workspace.yaml': 'packages:\n  - frontend',
      // The actual frontend lives under frontend/.
      'frontend/yarn.lock': '# yarn',
      'frontend/package.json': pkg({
        scripts: { build: 'vite build' },
        devDependencies: { vite: '^5' },
      }),
      'frontend/vite.config.ts': 'export default {}',
    })
    const rec = await detectFrontendConfig(reader, { directory: 'frontend' })
    expect(rec.detected).toBe(true)
    expect(rec.config.packageManager).toBe('yarn')
    expect(rec.config.outputDir).toBe('dist')
  })

  it('returns detected:false with a note when nothing frontend-shaped is found', async () => {
    const reader = makeReader({ 'README.md': '# repo' })
    const rec = await detectFrontendConfig(reader)
    expect(rec.detected).toBe(false)
    expect(rec.config).toEqual({ backendBindings: [] })
    expect(rec.notes.length).toBeGreaterThan(0)
  })
})
