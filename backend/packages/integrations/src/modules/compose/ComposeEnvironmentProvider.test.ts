import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import type {
  ProvisionEnvironmentRequest,
  RecipeStepLog,
  RunRepoContext,
  StackRecipe,
} from '@cat-factory/kernel'
import { ComposeEnvironmentProvider } from './ComposeEnvironmentProvider.js'
import type { ComposeExecResult, ComposeRuntime } from './compose-environment.logic.js'

type Script = (args: string[]) => ComposeExecResult

function fakeRuntime(
  script: Script,
  opts: { withCheckout?: boolean; existingFiles?: Set<string> } = {},
) {
  const calls: string[][] = []
  const composeEnvs: (Record<string, string> | undefined)[] = []
  const stdins: { checkoutFile: string }[] = []
  const written: { project: string; fileName: string; content: string }[] = []
  const checkouts: {
    project: string
    target: { cloneUrl: string; ref: string; token?: string }
  }[] = []
  const checkoutFiles: { project: string; relPath: string; content: string }[] = []
  const copies: { from: string; to: string }[] = []
  const hostCommands: { argv: string[]; workdir?: string }[] = []
  const runtime: ComposeRuntime = {
    async compose(args, options) {
      calls.push(args)
      composeEnvs.push(options?.env)
      if (options?.stdin) stdins.push({ checkoutFile: options.stdin.checkoutFile })
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
          async copyCheckoutFile(_project, from, to) {
            copies.push({ from, to })
          },
          async checkoutFileExists(_project, relPath) {
            return opts.existingFiles?.has(relPath) ?? false
          },
          async hostCommand(_project, argv, o) {
            hostCommands.push({ argv, ...(o?.workdir ? { workdir: o.workdir } : {}) })
            return { code: 0, stdout: '', stderr: '' }
          },
        }
      : {}),
  }
  return {
    runtime,
    calls,
    composeEnvs,
    stdins,
    written,
    checkouts,
    checkoutFiles,
    copies,
    hostCommands,
  }
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

describe('ComposeEnvironmentProvider — stack recipes', () => {
  afterEach(() => vi.unstubAllGlobals())

  const recipeManifest = (recipe: StackRecipe, extra: Record<string, unknown> = {}) => ({
    ...manifest,
    providerConfig: { service: 'web', port: '8080', ...extra, recipe },
  })

  // A recipe always needs a checkout runtime + a clone target; both the compose files it layers
  // must exist in the run repo.
  const recipeReq = (
    recipe: StackRecipe,
    opts: {
      files: Record<string, string>
      extra?: Record<string, unknown>
      recordStep?: ProvisionEnvironmentRequest['recordStep']
      ensureSharedStacks?: ProvisionEnvironmentRequest['ensureSharedStacks']
      runPreflights?: ProvisionEnvironmentRequest['runPreflights']
    } = {
      files: {},
    },
  ): ProvisionEnvironmentRequest =>
    baseReq({
      manifest: recipeManifest(recipe, opts.extra),
      runRepo: fakeRunRepo(opts.files),
      clone: () =>
        Promise.resolve({ cloneUrl: 'https://github.com/acme/shop.git', ref: 'main', token: 't' }),
      ...(opts.recordStep ? { recordStep: opts.recordStep } : {}),
      ...(opts.ensureSharedStacks ? { ensureSharedStacks: opts.ensureSharedStacks } : {}),
      ...(opts.runPreflights ? { runPreflights: opts.runPreflights } : {}),
    })

  // A script that greenlights a whole recipe bring-up (up/exec/host green, ps healthy, port bound).
  const greenScript: Script = (args) => {
    if (args.includes('port')) return { code: 0, stdout: '0.0.0.0:49200', stderr: '' }
    if (args.includes('ps')) return { code: 0, stdout: '[{"State":"running"}]', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }

  it('layers -f files, enables profiles, materializes env files, runs steps, then resolves the URL', async () => {
    const recipe: StackRecipe = {
      composeFiles: ['docker/dev.yml', 'docker/dev.override.yml'],
      composeProfiles: ['backends'],
      envFiles: [{ template: '.env.dev.local-dist', target: '.env.dev.local' }],
      setupSteps: [
        {
          kind: 'compose-exec',
          name: 'composer install',
          service: 'web',
          command: ['composer', 'install'],
        },
        {
          kind: 'compose-exec',
          name: 'migrate',
          service: 'web',
          command: ['bin/console', 'migrate'],
        },
      ],
      // healthGate omitted ⇒ compose-healthy (poll `ps`).
    }
    const { runtime, calls, composeEnvs, copies } = fakeRuntime(greenScript, { withCheckout: true })
    const env = await new ComposeEnvironmentProvider(runtime).provision(
      recipeReq(recipe, {
        files: {
          'docker/dev.yml':
            'services:\n  web:\n    image: nginx\n    ports:\n      - "8080:8080"\n',
          'docker/dev.override.yml': 'services:\n  web:\n    environment:\n      - FOO=bar\n',
        },
      }),
    )
    expect(env.status).toBe('ready')
    expect(env.url).toBe('http://localhost:49200')
    // `up -d` layered both rewritten files and did NOT `--wait` (readiness is the recipe gate).
    const up = calls.find((a) => a.includes('up'))!
    expect(up.filter((a) => a === '-f')).toHaveLength(2)
    expect(up).not.toContain('--wait')
    // Every compose call carried COMPOSE_PROFILES.
    const upEnv = composeEnvs[calls.indexOf(up)]
    expect(upEnv?.COMPOSE_PROFILES).toBe('backends')
    // The env-file template was materialized into its target inside the checkout.
    expect(copies).toEqual([{ from: '.env.dev.local-dist', to: '.env.dev.local' }])
    // Both setup steps ran (composer install + migrate) as non-interactive execs.
    const execs = calls.filter((a) => a.includes('exec'))
    expect(execs.some((a) => a.includes('composer'))).toBe(true)
    expect(execs.some((a) => a.includes('migrate'))).toBe(true)
  })

  it('streams a per-step provisioning-log entry (env file, up, each step, health gate)', async () => {
    const steps: RecipeStepLog[] = []
    const recipe: StackRecipe = {
      envFiles: [{ template: '.env.dist', target: '.env' }],
      setupSteps: [
        { kind: 'compose-exec', name: 'seed', service: 'db', command: ['sh', '-c', 'seed'] },
      ],
    }
    const { runtime } = fakeRuntime(greenScript, { withCheckout: true })
    const env = await new ComposeEnvironmentProvider(runtime).provision(
      recipeReq(recipe, {
        files: { 'docker-compose.yml': 'services:\n  web:\n    image: nginx\n' },
        recordStep: async (log) => {
          steps.push(log)
        },
      }),
    )
    expect(env.status).toBe('ready')
    expect(steps.map((s) => s.name)).toEqual([
      'env-file: .env',
      'compose up',
      'seed',
      'health gate (compose-healthy)',
    ])
    expect(steps.every((s) => s.outcome === 'success')).toBe(true)
  })

  it('pipes a seed dump into a compose-exec step via stdin', async () => {
    const recipe: StackRecipe = {
      setupSteps: [
        {
          kind: 'compose-exec',
          name: 'seed import',
          service: 'db',
          command: ['mysql'],
          stdinFile: 'deployment/dummy.sql',
        },
      ],
    }
    const { runtime, stdins } = fakeRuntime(greenScript, { withCheckout: true })
    const env = await new ComposeEnvironmentProvider(runtime).provision(
      recipeReq(recipe, {
        files: { 'docker-compose.yml': 'services:\n  web:\n    image: nginx\n' },
      }),
    )
    expect(env.status).toBe('ready')
    expect(stdins).toEqual([{ checkoutFile: 'deployment/dummy.sql' }])
  })

  it('passes an HTTP health gate by polling the URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('healthy', { status: 200 })),
    )
    const recipe: StackRecipe = {
      healthGate: {
        kind: 'http',
        url: 'http://localhost:8080/health',
        expectBodyContains: 'healthy',
      },
    }
    const { runtime } = fakeRuntime(greenScript, { withCheckout: true })
    const env = await new ComposeEnvironmentProvider(runtime).provision(
      recipeReq(recipe, {
        files: { 'docker-compose.yml': 'services:\n  web:\n    image: nginx\n' },
      }),
    )
    expect(env.status).toBe('ready')
    expect(fetch).toHaveBeenCalledWith('http://localhost:8080/health', expect.anything())
  })

  it('tears down and surfaces the failing step when a setup step fails', async () => {
    const steps: RecipeStepLog[] = []
    const recipe: StackRecipe = {
      setupSteps: [
        {
          kind: 'compose-exec',
          name: 'migrate',
          service: 'web',
          command: ['bin/console', 'migrate'],
        },
      ],
    }
    const { runtime, calls } = fakeRuntime(
      (args) => {
        if (args.includes('exec'))
          return { code: 1, stdout: '', stderr: 'migration failed: syntax error' }
        if (args.includes('port')) return { code: 0, stdout: '0.0.0.0:1', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
      { withCheckout: true },
    )
    const env = await new ComposeEnvironmentProvider(runtime).provision(
      recipeReq(recipe, {
        files: { 'docker-compose.yml': 'services:\n  web:\n    image: nginx\n' },
        recordStep: async (log) => {
          steps.push(log)
        },
      }),
    )
    expect(env.status).toBe('failed')
    expect(env.error).toContain("Recipe step 'migrate' failed")
    expect(env.error).toContain('migration failed')
    // The half-up stack was torn down for a clean retry, and the step logged a failure.
    expect(calls.some((a) => a.includes('down'))).toBe(true)
    expect(steps.find((s) => s.name === 'migrate')?.outcome).toBe('failure')
  })

  it('runs a host-command step only when the workspace opted in', async () => {
    const recipe: StackRecipe = {
      setupSteps: [{ kind: 'host-command', name: 'host prep', command: ['echo', 'hi'] }],
    }
    // Not opted in → refused before the daemon is touched.
    const denied = fakeRuntime(greenScript, { withCheckout: true })
    const off = await new ComposeEnvironmentProvider(denied.runtime).provision(
      recipeReq(recipe, {
        files: { 'docker-compose.yml': 'services:\n  web:\n    image: nginx\n' },
      }),
    )
    expect(off.status).toBe('failed')
    expect(off.error).toContain('host-command')
    expect(denied.calls).toHaveLength(0)

    // Opted in → the host command runs and the stack comes up.
    const allowed = fakeRuntime(greenScript, { withCheckout: true })
    const on = await new ComposeEnvironmentProvider(allowed.runtime).provision(
      recipeReq(recipe, {
        files: { 'docker-compose.yml': 'services:\n  web:\n    image: nginx\n' },
        extra: { allowHostCommands: 'true' },
      }),
    )
    expect(on.status).toBe('ready')
    expect(allowed.hostCommands).toEqual([{ argv: ['echo', 'hi'] }])
  })

  it('fails clearly when the runtime cannot materialize a checkout', async () => {
    const recipe: StackRecipe = { setupSteps: [] }
    const { runtime, calls } = fakeRuntime(greenScript) // no withCheckout
    const env = await new ComposeEnvironmentProvider(runtime).provision(
      recipeReq(recipe, {
        files: { 'docker-compose.yml': 'services:\n  web:\n    image: nginx\n' },
      }),
    )
    expect(env.status).toBe('failed')
    expect(env.error).toContain('Docker-capable runtime')
    expect(calls).toHaveLength(0)
  })

  it('refuses a checkout-escaping recipe path before touching the daemon', async () => {
    const recipe: StackRecipe = {
      envFiles: [{ template: '/etc/passwd', target: '.env' }],
    }
    const { runtime, calls } = fakeRuntime(greenScript, { withCheckout: true })
    const env = await new ComposeEnvironmentProvider(runtime).provision(
      recipeReq(recipe, {
        files: { 'docker-compose.yml': 'services:\n  web:\n    image: nginx\n' },
      }),
    )
    expect(env.status).toBe('failed')
    expect(env.error).toContain('escapes the checkout')
    expect(calls).toHaveLength(0)
  })

  it('ensures shared stacks up FIRST, then attaches the project to their managed networks', async () => {
    const ensureCalls: string[][] = []
    const recipe: StackRecipe = { sharedStackRefs: ['ss_shared'] }
    const { runtime, calls, checkoutFiles } = fakeRuntime(greenScript, { withCheckout: true })
    const env = await new ComposeEnvironmentProvider(runtime).provision(
      recipeReq(recipe, {
        files: { 'docker-compose.yml': 'services:\n  web:\n    image: nginx\n' },
        ensureSharedStacks: async (refs) => {
          ensureCalls.push(refs)
          return { ok: true, networks: ['acme-net'] }
        },
      }),
    )
    expect(env.status).toBe('ready')
    // The shared stack was ensured up before the consumer project was stood up.
    expect(ensureCalls).toEqual([['ss_shared']])
    // The rewritten compose declares acme-net external + joins `web` to it.
    const composeFile = checkoutFiles.find((f) => f.relPath.includes('cat-factory'))!
    const doc = parse(composeFile.content)
    expect(doc.networks).toEqual({ 'acme-net': { external: true } })
    expect(doc.services.web.networks).toEqual(['default', 'acme-net'])
    // The daemon was only touched (up) after the ensure resolved.
    expect(calls.some((a) => a.includes('up'))).toBe(true)
  })

  it('also attaches the recipe’s own declared externalNetworks (union with managed)', async () => {
    const recipe: StackRecipe = {
      sharedStackRefs: ['ss_shared'],
      externalNetworks: ['extra-net'],
    }
    const { runtime, checkoutFiles } = fakeRuntime(greenScript, { withCheckout: true })
    const env = await new ComposeEnvironmentProvider(runtime).provision(
      recipeReq(recipe, {
        files: { 'docker-compose.yml': 'services:\n  web:\n    image: nginx\n' },
        ensureSharedStacks: async () => ({ ok: true, networks: ['acme-net'] }),
      }),
    )
    expect(env.status).toBe('ready')
    const doc = parse(checkoutFiles.find((f) => f.relPath.includes('cat-factory'))!.content)
    expect(doc.networks).toEqual({
      'acme-net': { external: true },
      'extra-net': { external: true },
    })
    // Attach order is the recipe's declared externalNetworks, then the managed ones (functionally
    // irrelevant to compose; asserted here so the union is deterministic).
    expect(doc.services.web.networks).toEqual(['default', 'extra-net', 'acme-net'])
  })

  it('fails (never touches the daemon) when a shared stack cannot be brought up', async () => {
    const recipe: StackRecipe = { sharedStackRefs: ['ss_shared'] }
    const { runtime, calls } = fakeRuntime(greenScript, { withCheckout: true })
    const env = await new ComposeEnvironmentProvider(runtime).provision(
      recipeReq(recipe, {
        files: { 'docker-compose.yml': 'services:\n  web:\n    image: nginx\n' },
        ensureSharedStacks: async () => ({ ok: false, error: "shared stack 'db' is not running" }),
      }),
    )
    expect(env.status).toBe('failed')
    expect(env.error).toContain('Shared stacks could not be brought up')
    expect(env.error).toContain("shared stack 'db' is not running")
    expect(calls).toHaveLength(0)
  })

  it('fails loudly when a recipe references shared stacks but the seam is not wired', async () => {
    const recipe: StackRecipe = { sharedStackRefs: ['ss_shared'] }
    const { runtime, calls } = fakeRuntime(greenScript, { withCheckout: true })
    // No `ensureSharedStacks` in the request → the deployment can't orchestrate shared stacks.
    const env = await new ComposeEnvironmentProvider(runtime).provision(
      recipeReq(recipe, {
        files: { 'docker-compose.yml': 'services:\n  web:\n    image: nginx\n' },
      }),
    )
    expect(env.status).toBe('failed')
    expect(env.error).toContain('shared-stack orchestration is not available')
    expect(calls).toHaveLength(0)
  })

  it('runs preflight prerequisites and provisions when they all pass', async () => {
    const preflightCalls: unknown[][] = []
    const recipe: StackRecipe = {
      prerequisites: [
        { check: 'docker-daemon' },
        { check: 'registry-auth', params: { registry: 'reg.example.com' } },
      ],
    }
    const { runtime, calls } = fakeRuntime(greenScript, { withCheckout: true })
    const env = await new ComposeEnvironmentProvider(runtime).provision(
      recipeReq(recipe, {
        files: { 'docker-compose.yml': 'services:\n  web:\n    image: nginx\n' },
        runPreflights: async (refs) => {
          preflightCalls.push(refs)
          return refs.map((r) => ({
            check: r.check,
            title: r.check,
            status: 'pass',
            required: true,
          }))
        },
      }),
    )
    expect(env.status).toBe('ready')
    // Preflights were run with the declared refs, before any daemon work.
    expect(preflightCalls).toEqual([recipe.prerequisites])
    expect(calls.some((a) => a.includes('up'))).toBe(true)
  })

  it('fails fast (no daemon work) when a required preflight check fails, surfacing remediation', async () => {
    const recipe: StackRecipe = { prerequisites: [{ check: 'registry-auth' }] }
    const { runtime, calls } = fakeRuntime(greenScript, { withCheckout: true })
    const env = await new ComposeEnvironmentProvider(runtime).provision(
      recipeReq(recipe, {
        files: { 'docker-compose.yml': 'services:\n  web:\n    image: nginx\n' },
        runPreflights: async () => [
          {
            check: 'registry-auth',
            title: 'Container registry login',
            status: 'fail',
            required: true,
            detail: 'no docker login for reg',
            remediation: 'Run `docker login reg` and re-run.',
          },
        ],
      }),
    )
    expect(env.status).toBe('failed')
    expect(env.error).toContain('Preflight check(s) failed')
    expect(env.error).toContain('no docker login for reg')
    expect(env.error).toContain('docker login')
    // The daemon was never touched — the check failed before clone/up.
    expect(calls).toHaveLength(0)
  })

  it('proceeds when only a non-required preflight check warns', async () => {
    const recipe: StackRecipe = {
      prerequisites: [{ check: 'disk-space', params: { minGib: 16 }, required: false }],
    }
    const { runtime, calls } = fakeRuntime(greenScript, { withCheckout: true })
    const env = await new ComposeEnvironmentProvider(runtime).provision(
      recipeReq(recipe, {
        files: { 'docker-compose.yml': 'services:\n  web:\n    image: nginx\n' },
        runPreflights: async () => [
          { check: 'disk-space', title: 'Free disk space', status: 'warn', required: false },
        ],
      }),
    )
    expect(env.status).toBe('ready')
    expect(calls.some((a) => a.includes('up'))).toBe(true)
  })

  it('fails loudly when a recipe declares prerequisites but the preflight seam is not wired', async () => {
    const recipe: StackRecipe = { prerequisites: [{ check: 'docker-daemon' }] }
    const { runtime, calls } = fakeRuntime(greenScript, { withCheckout: true })
    // No `runPreflights` in the request → the deployment has no host-probe runtime.
    const env = await new ComposeEnvironmentProvider(runtime).provision(
      recipeReq(recipe, {
        files: { 'docker-compose.yml': 'services:\n  web:\n    image: nginx\n' },
      }),
    )
    expect(env.status).toBe('failed')
    expect(env.error).toContain('preflight checks are not available')
    expect(calls).toHaveLength(0)
  })

  it('streams a preflight provisioning-log entry per check', async () => {
    const steps: RecipeStepLog[] = []
    const recipe: StackRecipe = { prerequisites: [{ check: 'docker-daemon' }] }
    const { runtime } = fakeRuntime(greenScript, { withCheckout: true })
    await new ComposeEnvironmentProvider(runtime).provision(
      recipeReq(recipe, {
        files: { 'docker-compose.yml': 'services:\n  web:\n    image: nginx\n' },
        recordStep: async (log) => {
          steps.push(log)
        },
        runPreflights: async () => [
          {
            check: 'docker-daemon',
            title: 'Docker daemon reachable',
            status: 'pass',
            required: true,
            detail: 'Docker 27.0',
          },
        ],
      }),
    )
    expect(steps[0]).toMatchObject({
      name: 'preflight: Docker daemon reachable',
      outcome: 'success',
    })
  })
})
