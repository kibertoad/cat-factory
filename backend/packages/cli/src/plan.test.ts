import { describe, expect, it } from 'vitest'
import { type BootstrapInput, buildPlan } from './plan.js'

const input: BootstrapInput = {
  projectName: 'my-cats',
  appTitle: 'My Cats',
  provider: 'github',
  token: 'ghp_secret',
  databaseUrl: 'postgres://cat:cat@localhost:5432/catfactory',
  apiBase: 'http://localhost:8787',
  port: 8787,
  corsAllowedOrigins: 'http://localhost:3000',
  harnessImage: 'ghcr.io/x/y:latest',
  containerRuntime: 'docker',
  authSessionSecret: 'sess',
  encryptionKey: 'enc',
}

function plan(extra: Partial<BootstrapInput> = {}) {
  const files = buildPlan({ ...input, ...extra })
  const byPath = new Map(files.map((f) => [f.path, f]))
  return { files, byPath }
}

describe('buildPlan', () => {
  it('scaffolds both the local backend and the frontend', () => {
    const { byPath } = plan()
    for (const path of [
      '.gitignore',
      'README.md',
      'local/package.json',
      'local/src/main.ts',
      'local/docker-compose.yml',
      'local/.env',
      'local/.env.example',
      'frontend/package.json',
      'frontend/nuxt.config.ts',
      'frontend/wrangler.toml',
      'frontend/.env',
      'frontend/.env.example',
    ]) {
      expect(byPath.has(path), `expected ${path}`).toBe(true)
    }
  })

  it('marks the .env files as secret', () => {
    const { byPath } = plan()
    expect(byPath.get('local/.env')?.secret).toBe(true)
    expect(byPath.get('frontend/.env')?.secret).toBe(true)
    expect(byPath.get('local/.env.example')?.secret).toBeFalsy()
  })

  it('threads the token + secrets into local/.env', () => {
    const env = plan().byPath.get('local/.env')?.content ?? ''
    expect(env).toContain('GITHUB_PAT=ghp_secret')
    expect(env).toContain('AUTH_SESSION_SECRET=sess')
    expect(env).toContain('ENCRYPTION_KEY=enc')
  })

  it('derives the docker-compose db from the DATABASE_URL', () => {
    const compose =
      plan({ databaseUrl: 'postgres://bob:pw@localhost:6000/mydb' }).byPath.get(
        'local/docker-compose.yml',
      )?.content ?? ''
    expect(compose).toContain('POSTGRES_USER: bob')
    expect(compose).toContain('POSTGRES_PASSWORD: pw')
    expect(compose).toContain('POSTGRES_DB: mydb')
    expect(compose).toContain("- '6000:5432'")
  })

  it('builds a fresh .gitignore when none exists', () => {
    const gi = plan().byPath.get('.gitignore')?.content ?? ''
    expect(gi).toContain('.env')
    expect(gi).toContain('!.env.example')
  })

  it('merges into an existing .gitignore', () => {
    const gi =
      plan({ existingGitignore: '# theirs\nfoo/\n' }).byPath.get('.gitignore')?.content ?? ''
    expect(gi).toContain('# theirs')
    expect(gi).toContain('foo/')
    expect(gi).toContain('.env')
  })

  it('uses the gitlab env var for a gitlab project', () => {
    const env = plan({ provider: 'gitlab' }).byPath.get('local/.env')?.content ?? ''
    expect(env).toContain('GITLAB_PAT=ghp_secret')
  })

  it('threads the chosen container runtime into local/.env and its example', () => {
    const { byPath } = plan({ containerRuntime: 'podman' })
    expect(byPath.get('local/.env')?.content ?? '').toContain('LOCAL_CONTAINER_RUNTIME=podman')
    expect(byPath.get('local/.env.example')?.content ?? '').toContain(
      'LOCAL_CONTAINER_RUNTIME=podman',
    )
  })

  it('makes the .env.example match the chosen provider', () => {
    const example = plan({ provider: 'gitlab' }).byPath.get('local/.env.example')?.content ?? ''
    expect(example).toContain('\nGITLAB_PAT=')
    expect(example).toContain('# GITHUB_PAT=')
  })

  it('reflects the chosen port/db in the .env.example files (not a hardcoded 8787)', () => {
    const { byPath } = plan({
      port: 9001,
      databaseUrl: 'postgres://bob:pw@localhost:6000/mydb',
      apiBase: 'http://localhost:9001',
    })
    const localExample = byPath.get('local/.env.example')?.content ?? ''
    expect(localExample).toContain('PORT=9001')
    expect(localExample).toContain('DATABASE_URL=postgres://bob:pw@localhost:6000/mydb')
    const frontendExample = byPath.get('frontend/.env.example')?.content ?? ''
    expect(frontendExample).toContain('NUXT_PUBLIC_API_BASE=http://localhost:9001')
  })

  it('warns in the README when db:up needs a non-docker runtime', () => {
    expect(plan({ containerRuntime: 'apple' }).byPath.get('README.md')?.content ?? '').toContain(
      'Apple `container` note',
    )
    expect(plan({ containerRuntime: 'podman' }).byPath.get('README.md')?.content ?? '').toContain(
      'Podman note',
    )
    // No note for a docker-family runtime that ships `docker compose`.
    expect(
      plan({ containerRuntime: 'orbstack' }).byPath.get('README.md')?.content ?? '',
    ).not.toMatch(/db:up.*runs `docker compose`/)
  })
})
