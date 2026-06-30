import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import type { ProvisionEnvironmentRequest, RunRepoContext } from '@cat-factory/kernel'
import { ComposeEnvironmentProvider } from './ComposeEnvironmentProvider.js'
import type { ComposeExecResult, ComposeRuntime } from './compose-environment.logic.js'

type Script = (args: string[]) => ComposeExecResult

function fakeRuntime(script: Script) {
  const calls: string[][] = []
  const written: { project: string; fileName: string; content: string }[] = []
  const runtime: ComposeRuntime = {
    async compose(args) {
      calls.push(args)
      return script(args)
    },
    async writeProjectFile(project, fileName, content) {
      written.push({ project, fileName, content })
      return `/tmp/${project}/${fileName}`
    },
  }
  return { runtime, calls, written }
}

function fakeRunRepo(files: Record<string, string>): RunRepoContext {
  return {
    baseBranch: 'main',
    repo: {
      async getFile(path) {
        const content = files[path]
        return content === undefined ? null : { content, sha: 'sha1' }
      },
    } as RunRepoContext['repo'],
  }
}

const manifest = {
  providerId: 'compose',
  label: 'Compose',
  baseUrl: 'http://localhost',
  auth: { type: 'none' as const },
  provision: { method: 'POST' as const, pathTemplate: '' },
  response: {},
  providerConfig: { service: 'web', port: '8080' },
}

const baseReq = (
  overrides: Partial<ProvisionEnvironmentRequest> = {},
): ProvisionEnvironmentRequest => ({
  manifest,
  inputs: { repoName: 'shop', pullNumber: '42', branch: 'feature/x' },
  resolveSecret: () => undefined,
  runRepo: fakeRunRepo({ 'docker-compose.yml': 'services:\n  web:\n    image: nginx\n' }),
  ...overrides,
})

describe('ComposeEnvironmentProvider', () => {
  it('brings the stack up, reads the published port, and returns a localhost URL', async () => {
    const { runtime, calls } = fakeRuntime((args) => {
      if (args.includes('up')) return { code: 0, stdout: '', stderr: '' }
      if (args.includes('port')) return { code: 0, stdout: '0.0.0.0:49153\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const provider = new ComposeEnvironmentProvider(runtime)
    const env = await provider.provision(baseReq())

    expect(env.status).toBe('ready')
    expect(env.url).toBe('http://localhost:49153')
    expect(env.externalId).toBe('cf-env-shop-42')
    expect(env.fields.project).toBe('cf-env-shop-42')
    // Project-scoped + a SINGLE rewritten compose file passed to `up` (no additive override).
    const up = calls.find((a) => a.includes('up'))!
    expect(up).toContain('-p')
    expect(up).toContain('cf-env-shop-42')
    expect(up.filter((a) => a === '-f')).toHaveLength(1)
    expect(up).toContain('--wait')
  })

  it('rewrites a pinned host port to ephemeral so concurrent stacks never collide', async () => {
    const { runtime, written } = fakeRuntime((args) => {
      if (args.includes('port')) return { code: 0, stdout: '0.0.0.0:49153', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const provider = new ComposeEnvironmentProvider(runtime)
    const env = await provider.provision(
      baseReq({
        runRepo: fakeRunRepo({
          'docker-compose.yml':
            'services:\n  web:\n    image: nginx\n    ports:\n      - "8080:8080"\n',
        }),
      }),
    )
    expect(env.status).toBe('ready')
    // The written project file publishes the container port to an EPHEMERAL host port (no `8080:8080`).
    const file = written.find((w) => w.fileName === 'compose.yaml')!
    expect(parse(file.content).services.web.ports).toEqual(['8080'])
  })

  it('refuses a stack that bind-mounts a host path (no repo on disk) before touching the daemon', async () => {
    const { runtime, calls } = fakeRuntime(() => ({ code: 0, stdout: '', stderr: '' }))
    const provider = new ComposeEnvironmentProvider(runtime)
    const env = await provider.provision(
      baseReq({
        runRepo: fakeRunRepo({
          'docker-compose.yml':
            'services:\n  web:\n    image: nginx\n    volumes:\n      - ./src:/app\n',
        }),
      }),
    )
    expect(env.status).toBe('failed')
    expect(env.error).toContain('bind-mounts a host path')
    // It fails fast — the daemon is never invoked.
    expect(calls).toHaveLength(0)
  })

  it('sets an auto-teardown expiry from ttlMinutes', async () => {
    const { runtime } = fakeRuntime((args) => {
      if (args.includes('port')) return { code: 0, stdout: '0.0.0.0:49153', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const provider = new ComposeEnvironmentProvider(runtime)
    const before = Date.now()
    const env = await provider.provision(
      baseReq({
        manifest: {
          ...manifest,
          providerConfig: { service: 'web', port: '8080', ttlMinutes: '60' },
        },
      }),
    )
    expect(env.expiresAt).not.toBeNull()
    expect(env.expiresAt!).toBeGreaterThanOrEqual(before + 60 * 60_000)
  })

  it('returns a non-throwing failure carrying the compose error when up fails', async () => {
    const { runtime, calls } = fakeRuntime((args) => {
      if (args.includes('up'))
        return { code: 1, stdout: '', stderr: 'service "web" failed to build' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const provider = new ComposeEnvironmentProvider(runtime)
    const env = await provider.provision(baseReq())

    expect(env.status).toBe('failed')
    expect(env.error).toContain('failed to build')
    expect(env.url).toBeNull()
    // It tears the half-up stack down for a clean retry.
    expect(calls.some((a) => a.includes('down'))).toBe(true)
  })

  it('fails clearly when the service publishes no host port', async () => {
    const { runtime } = fakeRuntime((args) => {
      if (args.includes('up')) return { code: 0, stdout: '', stderr: '' }
      if (args.includes('port')) return { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const provider = new ComposeEnvironmentProvider(runtime)
    const env = await provider.provision(baseReq())
    expect(env.status).toBe('failed')
    expect(env.error).toContain('does not publish container port 8080')
  })

  it('tears down by project with down -v (idempotent)', async () => {
    const { runtime, calls } = fakeRuntime(() => ({ code: 0, stdout: '', stderr: '' }))
    const provider = new ComposeEnvironmentProvider(runtime)
    const res = await provider.teardown({
      manifest,
      externalId: 'cf-env-shop-42',
      provisionFields: { project: 'cf-env-shop-42' },
      resolveSecret: () => undefined,
    })
    expect(res.status).toBe('torn_down')
    const down = calls.find((a) => a.includes('down'))!
    expect(down).toEqual(['-p', 'cf-env-shop-42', 'down', '-v', '--remove-orphans'])
  })

  it('reads the compose file from a separate repo when configured', async () => {
    const separate = fakeRunRepo({ 'ops/compose.yml': 'services:\n  web:\n    image: nginx\n' })
    const { runtime } = fakeRuntime((args) => {
      if (args.includes('port')) return { code: 0, stdout: '0.0.0.0:5000', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const provider = new ComposeEnvironmentProvider(runtime)
    const env = await provider.provision(
      baseReq({
        manifest: {
          ...manifest,
          providerConfig: {
            service: 'web',
            port: '8080',
            composePath: 'ops/compose.yml',
            composeRepo: 'acme/ops',
          },
        },
        runRepo: undefined,
        resolveRepoFiles: async () => separate,
      }),
    )
    expect(env.status).toBe('ready')
    expect(env.url).toBe('http://localhost:5000')
  })

  it('testConnection reports reachable only when the daemon answers (not just the CLI)', async () => {
    const reachable = fakeRuntime((args) => {
      if (args.includes('version')) return { code: 0, stdout: 'v2.29.0', stderr: '' }
      if (args.includes('ls')) return { code: 0, stdout: '[]', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const ok = await new ComposeEnvironmentProvider(reachable.runtime).testConnection({
      config: {},
      resolveSecret: () => undefined,
    })
    expect(ok.ok).toBe(true)
    expect(ok.message).toContain('v2.29.0')

    // The CLI is installed (version succeeds) but the daemon is down (`ls` fails) ⇒ NOT reachable.
    const daemonDown = fakeRuntime((args) => {
      if (args.includes('version')) return { code: 0, stdout: 'v2.29.0', stderr: '' }
      if (args.includes('ls'))
        return { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const bad = await new ComposeEnvironmentProvider(daemonDown.runtime).testConnection({
      config: {},
      resolveSecret: () => undefined,
    })
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain('daemon')
  })
})
