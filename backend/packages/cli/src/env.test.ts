import { describe, expect, it } from 'vitest'
import { buildFrontendEnv, buildLocalEnv, renderEnvFile } from './env.js'

describe('renderEnvFile', () => {
  it('renders comments above entries and ends with a newline', () => {
    const out = renderEnvFile([
      { key: 'A', value: '1', comment: ['hello'] },
      { key: 'B', value: '2' },
    ])
    expect(out).toBe('# hello\nA=1\n\nB=2\n')
  })
})

describe('buildLocalEnv', () => {
  const base = {
    databaseUrl: 'postgres://cat:cat@localhost:5432/catfactory',
    authSessionSecret: 'deadbeef',
    encryptionKey: 'YmFzZTY0',
    harnessImage: 'ghcr.io/x/y:latest',
    port: 8787,
    corsAllowedOrigins: 'http://localhost:3000',
    containerRuntime: 'docker' as const,
  }

  it('writes the github token under GITHUB_PAT', () => {
    const out = buildLocalEnv({ ...base, provider: 'github', token: 'ghp_123' })
    expect(out).toContain('GITHUB_PAT=ghp_123')
    expect(out).toContain('DATABASE_URL=postgres://cat:cat@localhost:5432/catfactory')
    expect(out).toContain('AUTH_SESSION_SECRET=deadbeef')
    expect(out).toContain('ENCRYPTION_KEY=YmFzZTY0')
    expect(out).toContain('LOCAL_HARNESS_IMAGE=ghcr.io/x/y:latest')
    expect(out).not.toContain('GITLAB_PAT=')
  })

  it('writes the gitlab token under GITLAB_PAT', () => {
    const out = buildLocalEnv({ ...base, provider: 'gitlab', token: 'glpat-9' })
    expect(out).toContain('GITLAB_PAT=glpat-9')
    expect(out).not.toMatch(/^GITHUB_PAT=/m)
  })

  it('leaves the token blank when none is supplied', () => {
    const out = buildLocalEnv({ ...base, provider: 'github' })
    expect(out).toMatch(/^GITHUB_PAT=$/m)
  })

  it('writes the chosen container runtime', () => {
    const out = buildLocalEnv({ ...base, provider: 'github', containerRuntime: 'orbstack' })
    expect(out).toContain('LOCAL_CONTAINER_RUNTIME=orbstack')
  })
})

describe('buildFrontendEnv', () => {
  it('writes the API base', () => {
    expect(buildFrontendEnv({ apiBase: 'http://localhost:8787' })).toContain(
      'NUXT_PUBLIC_API_BASE=http://localhost:8787',
    )
  })
})
