import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import type { ProvisionEnvironmentRequest, RunRepoContext } from '@cat-factory/kernel'
import { ComposeEnvironmentProvider } from './ComposeEnvironmentProvider.js'
import type { ComposeExecResult, ComposeRuntime } from './compose-environment.logic.js'

type Script = (args: string[]) => ComposeExecResult

function fakeRuntime(script: Script, opts: { withCheckout?: boolean } = {}) {
  const calls: string[][] = []
  const written: { project: string; fileName: string; content: string }[] = []
  const checkouts: {
    project: string
    target: { cloneUrl: string; ref: string; token?: string }
  }[] = []
  const checkoutFiles: { project: string; relPath: string; content: string }[] = []
  const runtime: ComposeRuntime = {
    async compose(args) {
      calls.push(args)
      return script(args)
    },
    async writeProjectFile(project, fileName, content) {
      written.push({ project, fileName, content })
      return `/tmp/${project}/${fileName}`
    },
    ...(opts.withCheckout
      ? {
          async checkout(project, target) {
            checkouts.push({ project, target })
            return { dir: `/tmp/${project}/checkout` }
          },
          async writeCheckoutFile(project, relPath, content) {
            checkoutFiles.push({ project, relPath, content })
            return `/tmp/${project}/checkout/${relPath}`
          },
        }
      : {}),
  }
  return { runtime, calls, written, checkouts, checkoutFiles }
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

  describe('build-from-source mode', () => {
    const buildManifest = {
      ...manifest,
      providerConfig: { service: 'web', port: '8080', build: 'true' },
    }
    const buildReq = (overrides: Partial<ProvisionEnvironmentRequest> = {}) =>
      baseReq({
        manifest: buildManifest,
        runRepo: fakeRunRepo({
          // A build-based stack: builds its image, in-checkout bind, relative env_file.
          'docker-compose.yml':
            'services:\n  web:\n    build: .\n    volumes:\n      - ./init:/init\n    env_file:\n      - ./.env\n',
        }),
        clone: () =>
          Promise.resolve({
            cloneUrl: 'https://github.com/acme/shop.git',
            ref: 'main',
            token: 'ghs_secret',
          }),
        ...overrides,
      })

    it('clones the PR head, builds, then ups, and resolves the URL', async () => {
      const { runtime, calls, checkouts, checkoutFiles } = fakeRuntime(
        (args) => {
          if (args.includes('port')) return { code: 0, stdout: '0.0.0.0:49155', stderr: '' }
          return { code: 0, stdout: '', stderr: '' }
        },
        { withCheckout: true },
      )
      const provider = new ComposeEnvironmentProvider(runtime)
      const env = await provider.provision(buildReq())

      expect(env.status).toBe('ready')
      expect(env.url).toBe('http://localhost:49155')
      // Cloned the PR head branch with the resolved token.
      expect(checkouts).toHaveLength(1)
      expect(checkouts[0]!.target).toEqual({
        cloneUrl: 'https://github.com/acme/shop.git',
        ref: 'feature/x', // inputs.branch wins over clone.ref
        token: 'ghs_secret',
      })
      // Wrote the rewritten compose beside the original inside the checkout (root-level here).
      expect(checkoutFiles).toHaveLength(1)
      expect(checkoutFiles[0]!.relPath).toBe('cat-factory.compose.yaml')
      // build ran BEFORE up, both scoped with --project-directory into the checkout.
      const buildIdx = calls.findIndex((a) => a.includes('build'))
      const upIdx = calls.findIndex((a) => a.includes('up'))
      expect(buildIdx).toBeGreaterThanOrEqual(0)
      expect(buildIdx).toBeLessThan(upIdx)
      expect(calls[buildIdx]).toContain('--project-directory')
      expect(calls[buildIdx]).toContain('/tmp/cf-env-shop-42/checkout')
    })

    it('places the rewritten compose in the compose file’s own subdirectory', async () => {
      const { runtime, checkoutFiles, calls } = fakeRuntime(
        (args) => {
          if (args.includes('port')) return { code: 0, stdout: '0.0.0.0:5001', stderr: '' }
          return { code: 0, stdout: '', stderr: '' }
        },
        { withCheckout: true },
      )
      const provider = new ComposeEnvironmentProvider(runtime)
      const env = await provider.provision(
        buildReq({
          manifest: {
            ...buildManifest,
            providerConfig: {
              service: 'web',
              port: '8080',
              build: 'true',
              composePath: 'deploy/docker-compose.yml',
            },
          },
          runRepo: fakeRunRepo({
            'deploy/docker-compose.yml': 'services:\n  web:\n    build: ..\n',
          }),
        }),
      )
      expect(env.status).toBe('ready')
      expect(checkoutFiles[0]!.relPath).toBe('deploy/cat-factory.compose.yaml')
      const build = calls.find((a) => a.includes('build'))!
      expect(build).toContain('/tmp/cf-env-shop-42/checkout/deploy')
    })

    it('fails clearly when the runtime cannot clone + build (no checkout capability)', async () => {
      const { runtime, calls } = fakeRuntime(() => ({ code: 0, stdout: '', stderr: '' }))
      const provider = new ComposeEnvironmentProvider(runtime)
      const env = await provider.provision(buildReq())
      expect(env.status).toBe('failed')
      expect(env.error).toContain('Docker-capable runtime')
      // Never reached the daemon.
      expect(calls).toHaveLength(0)
    })

    it('fails clearly when no clone target is available', async () => {
      const { runtime, calls } = fakeRuntime(() => ({ code: 0, stdout: '', stderr: '' }), {
        withCheckout: true,
      })
      const provider = new ComposeEnvironmentProvider(runtime)
      const env = await provider.provision(buildReq({ clone: undefined }))
      expect(env.status).toBe('failed')
      expect(env.error).toContain('repo clone target')
      expect(calls).toHaveLength(0)
    })

    it('surfaces a build failure and tears down for a clean retry', async () => {
      const { runtime, calls } = fakeRuntime(
        (args) => {
          if (args.includes('build'))
            return { code: 1, stdout: '', stderr: 'ERROR: failed to solve: dockerfile' }
          return { code: 0, stdout: '', stderr: '' }
        },
        { withCheckout: true },
      )
      const provider = new ComposeEnvironmentProvider(runtime)
      const env = await provider.provision(buildReq())
      expect(env.status).toBe('failed')
      expect(env.error).toContain('failed to solve')
      // No `up` after a failed build; a teardown ran for a clean retry.
      expect(calls.some((a) => a.includes('up'))).toBe(false)
      expect(calls.some((a) => a.includes('down'))).toBe(true)
    })
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
