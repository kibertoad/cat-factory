import { describe, expect, it } from 'vitest'
import type { FrontendRepoReader } from './frontend-detect.logic.js'
import { detectFrontendConfig } from './frontend-detect.logic.js'
import { RepoReadError } from './repo-read-error.js'

// In-memory RepoFiles-shaped reader built from a flat path→content map. A missing path yields
// `null` (mirroring the contents API), which is all the detector's targeted reads need.
function makeReader(files: Record<string, string>): FrontendRepoReader {
  return {
    async getFile(path) {
      return path in files ? { content: files[path]! } : null
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

  it('flags Nuxt output dir as low confidence and picks generate so build+output agree', async () => {
    const reader = makeReader({
      'pnpm-lock.yaml': 'x',
      'package.json': pkg({
        scripts: { build: 'nuxt build', generate: 'nuxt generate' },
        dependencies: { nuxt: '^3' },
      }),
    })
    const rec = await detectFrontendConfig(reader)
    expect(rec.config.outputDir).toBe('.output/public')
    // `.output/public` is the `nuxt generate` output, so the build script must be `generate`, not
    // the SSR `build` that would populate a different directory.
    expect(rec.config.buildScript).toBe('generate')
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

  it('does NOT treat a CRA "start" (dev server) as a serve script', async () => {
    const reader = makeReader({
      'package-lock.json': '{}',
      'package.json': pkg({
        scripts: { start: 'react-scripts start', build: 'react-scripts build' },
        dependencies: { 'react-scripts': '^5' },
      }),
    })
    const rec = await detectFrontendConfig(reader)
    // `start` is CRA's dev server, not a preview of the built app ⇒ static, no serve script.
    expect(rec.config.serveMode).toBe('static')
    expect(rec.config.serveScript).toBeUndefined()
    expect(rec.config.outputDir).toBe('build')
  })

  it('ignores prefixed non-URL env vars, keeping only URL-shaped ones', async () => {
    const reader = makeReader({
      'pnpm-lock.yaml': 'x',
      'package.json': pkg({ scripts: { build: 'vite build' }, devDependencies: { vite: '^5' } }),
      '.env.example':
        'VITE_API_URL=http://localhost:3000\nVITE_APP_TITLE=My App\nNEXT_PUBLIC_GA_ID=UA-123\nVITE_SERVICE_ENDPOINT=\n',
    })
    const rec = await detectFrontendConfig(reader)
    const envVars = rec.config.backendBindings.map((b) => b.envVar).sort()
    // Only the URL/endpoint-shaped names — the title + analytics id (which merely share a public
    // prefix) are dropped.
    expect(envVars).toEqual(['VITE_API_URL', 'VITE_SERVICE_ENDPOINT'])
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

  it('throws RepoReadError when the repo is unreadable rather than "not a frontend repo"', async () => {
    const reader: FrontendRepoReader = {
      async getFile() {
        throw new Error('GitHub GET /contents → 403: forbidden')
      },
    }
    await expect(detectFrontendConfig(reader)).rejects.toThrow(RepoReadError)
  })
})
