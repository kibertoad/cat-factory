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

  it('includes container->host reachability + security hints (commented)', () => {
    const out = buildLocalEnv({ ...base, provider: 'github', containerRuntime: 'docker' })
    expect(out).toContain('# LOCAL_HARNESS_HOST_ALIAS=')
    expect(out).toContain('# AUTH_DEV_OPEN=false')
    // Docker/Podman get the native-Linux add-host-gateway hint...
    expect(out).toContain('# LOCAL_DOCKER_ADD_HOST_GATEWAY=true')
  })

  it('omits the docker add-host hint for runtimes without a docker bridge', () => {
    const out = buildLocalEnv({ ...base, provider: 'github', containerRuntime: 'apple' })
    expect(out).not.toContain('LOCAL_DOCKER_ADD_HOST_GATEWAY')
    // ...but the host-alias hint (which Apple most needs) is always present.
    expect(out).toContain('# LOCAL_HARNESS_HOST_ALIAS=')
  })

  it('defaults to pool mode: native knobs commented + warm-pool pointer', () => {
    const out = buildLocalEnv({ ...base, provider: 'github' })
    expect(out).toContain('# LOCAL_NATIVE_AGENTS=')
    expect(out).toContain('# LOCAL_HARNESS_ENTRY=')
    expect(out).toMatch(/PREWARMED DOCKER POOL/)
    // No active native vars in pool mode.
    expect(out).not.toMatch(/^LOCAL_NATIVE_AGENTS=/m)
  })

  it('writes active native vars + applicable models in native mode', () => {
    const out = buildLocalEnv({
      ...base,
      provider: 'github',
      executionMode: 'native',
      nativeHarnesses: ['claude-code'],
      harnessEntry: '/opt/harness/server.js',
    })
    expect(out).toMatch(/^LOCAL_NATIVE_AGENTS=claude-code$/m)
    expect(out).toMatch(/^LOCAL_HARNESS_ENTRY=\/opt\/harness\/server\.js$/m)
    // Only claude-code models are named as running natively.
    expect(out).toContain('Claude Opus 4.8 (claude-opus)')
    expect(out).not.toContain('GPT-5.5')
  })

  it('native mode with no harnesses named enables both', () => {
    const out = buildLocalEnv({ ...base, provider: 'github', executionMode: 'native' })
    expect(out).toMatch(/^LOCAL_NATIVE_AGENTS=claude-code,codex$/m)
  })

  it('surfaces commonly-useful optional settings (commented, with defaults)', () => {
    const out = buildLocalEnv({ ...base, provider: 'github' })
    expect(out).toContain('# AUTH_PASSWORD_ENABLED=true')
    expect(out).toContain('# AUTH_OPEN_SIGNUP=true')
    expect(out).toContain('# LOCAL_HARNESS_IMAGE_REFRESH=off')
    expect(out).toContain('# LANGFUSE_ENABLED=true')
    expect(out).toContain('# SLACK_ENABLED=true')
    expect(out).toContain('# CONSENSUS_ENABLED=true')
    // GitLab-only knob is absent for a GitHub deployment.
    expect(out).not.toContain('GITLAB_API_BASE')
  })

  it('adds the GitLab API base hint only for a gitlab deployment', () => {
    const out = buildLocalEnv({ ...base, provider: 'gitlab' })
    expect(out).toContain('# GITLAB_API_BASE=')
  })
})

describe('buildFrontendEnv', () => {
  it('writes the API base', () => {
    expect(buildFrontendEnv({ apiBase: 'http://localhost:8787' })).toContain(
      'NUXT_PUBLIC_API_BASE=http://localhost:8787',
    )
  })
})
