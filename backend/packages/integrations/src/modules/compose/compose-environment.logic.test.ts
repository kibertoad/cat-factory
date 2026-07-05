import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  classifyComposePs,
  collectUnsupportedComposeRefs,
  composeConfigToManifest,
  composeFileDir,
  ensureServicePublishes,
  escapesCheckout,
  extractComposeProfiles,
  extractExternalNetworks,
  hasBuildDirective,
  neutralizeHostPorts,
  parseComposeEnvConfig,
  parseComposePsRows,
  parseHostPort,
  prepareComposeProject,
  renderEnvMap,
  resolveProjectName,
  sanitizeProjectName,
  toEphemeralPortEntry,
  // stack-recipe helpers
  composeExecArgs,
  matchesHttpExpectation,
  prepareRecipeComposeFiles,
  recipeCheckoutPathIssues,
  recipeProfilesEnv,
  recipeStepTimeoutMs,
  resolveRecipeComposeFiles,
  rewrittenRecipeComposePath,
  waitFileExecArgs,
  DEFAULT_RECIPE_STEP_TIMEOUT_MS,
  DEFAULT_RECIPE_WAIT_TIMEOUT_MS,
} from './compose-environment.logic.js'
import type { StackRecipe } from '@cat-factory/kernel'

const manifestWith = (providerConfig: Record<string, unknown>) => ({
  providerId: 'compose',
  label: 'Compose',
  baseUrl: 'http://localhost',
  auth: { type: 'none' as const },
  provision: { method: 'POST' as const, pathTemplate: '' },
  response: {},
  providerConfig,
})

describe('parseComposeEnvConfig', () => {
  it('reads + coerces the flat providerConfig (port from its string form)', () => {
    const config = parseComposeEnvConfig(manifestWith({ service: 'web', port: '8080' }))
    expect(config.service).toBe('web')
    expect(config.port).toBe(8080)
    expect(config.composePath).toBe('docker-compose.yml') // default
    expect(config.scheme).toBe('http')
  })

  it('throws on a missing service', () => {
    expect(() => parseComposeEnvConfig(manifestWith({ port: '8080' }))).toThrow(/web service name/)
  })

  it('throws on an out-of-range port', () => {
    expect(() => parseComposeEnvConfig(manifestWith({ service: 'web', port: '70000' }))).toThrow(
      /invalid container port/,
    )
  })

  it('round-trips through composeConfigToManifest', () => {
    const config = parseComposeEnvConfig(
      manifestWith({
        service: 'api',
        port: '3000',
        composePath: 'deploy/compose.yml',
        scheme: 'https',
      }),
    )
    const manifest = composeConfigToManifest(config)
    const reparsed = parseComposeEnvConfig(manifest)
    expect(reparsed.service).toBe('api')
    expect(reparsed.port).toBe(3000)
    expect(reparsed.composePath).toBe('deploy/compose.yml')
    expect(reparsed.scheme).toBe('https')
  })

  it('reads the auto-teardown TTL from ttlMinutes (and treats 0/blank as never-expire)', () => {
    expect(
      parseComposeEnvConfig(manifestWith({ service: 'web', port: '80', ttlMinutes: '30' }))
        .defaultTtlMs,
    ).toBe(30 * 60_000)
    expect(
      parseComposeEnvConfig(manifestWith({ service: 'web', port: '80', ttlMinutes: '0' }))
        .defaultTtlMs,
    ).toBeUndefined()
    expect(
      parseComposeEnvConfig(manifestWith({ service: 'web', port: '80' })).defaultTtlMs,
    ).toBeUndefined()
  })
})

describe('sanitizeProjectName', () => {
  it('lower-cases, strips invalid chars, and bounds length', () => {
    expect(sanitizeProjectName('My App/PR #42')).toBe('my-app-pr-42')
    expect(sanitizeProjectName('---')).toBe('cf-env')
    expect(sanitizeProjectName('9lives')).toBe('9lives')
  })
})

describe('resolveProjectName', () => {
  const base = parseComposeEnvConfig(manifestWith({ service: 'web', port: '80' }))

  it('qualifies the PR number with the repo by default (avoids cross-repo collisions)', () => {
    expect(resolveProjectName(base, { repoName: 'shop', pullNumber: '42' })).toBe('cf-env-shop-42')
  })

  it('falls back to the block id when repo/PR context is absent', () => {
    expect(resolveProjectName(base, { blockId: 'blk_abc' })).toBe('cf-env-blk_abc')
  })

  it('renders + sanitizes an explicit template', () => {
    const config = parseComposeEnvConfig(
      manifestWith({ service: 'web', port: '80', projectTemplate: 'env-{{branch}}' }),
    )
    expect(resolveProjectName(config, { branch: 'Feature/X' })).toBe('env-feature-x')
  })

  it('disambiguates the default name with the block id (no cross-workspace collisions)', () => {
    // Two workspaces can share a repo name + PR number on one host; the globally-unique block
    // id is folded in so their projects (and so their `up`/`down`) can never collide.
    const a = resolveProjectName(base, { repoName: 'shop', pullNumber: '42', blockId: 'blk_a' })
    const b = resolveProjectName(base, { repoName: 'shop', pullNumber: '42', blockId: 'blk_b' })
    expect(a).toMatch(/^cf-env-shop-42-[a-z0-9]+$/)
    expect(a).not.toBe(b)
  })
})

describe('toEphemeralPortEntry', () => {
  it('strips the host ip + published host port, keeping the container target', () => {
    expect(toEphemeralPortEntry('8080:8080')).toBe('8080')
    expect(toEphemeralPortEntry('127.0.0.1:8080:8080')).toBe('8080')
    expect(toEphemeralPortEntry('8080')).toBe('8080')
    expect(toEphemeralPortEntry('5000:5000/udp')).toBe('5000/udp')
    expect(toEphemeralPortEntry({ published: 8080, target: 3000 })).toBe('3000')
  })
})

describe('neutralizeHostPorts', () => {
  it('forces every service host port ephemeral so concurrent stacks never collide', () => {
    const doc = parse(
      'services:\n  web:\n    image: nginx\n    ports:\n      - "8080:8080"\n  db:\n    image: pg\n    ports:\n      - "5432:5432"\n',
    )
    neutralizeHostPorts(doc)
    expect(doc.services.web.ports).toEqual(['8080'])
    expect(doc.services.db.ports).toEqual(['5432'])
  })
})

describe('ensureServicePublishes', () => {
  it('adds the probed port when the service does not already publish it', () => {
    const doc = parse('services:\n  web:\n    image: nginx\n')
    ensureServicePublishes(doc, 'web', 8080)
    expect(doc.services.web.ports).toEqual(['8080'])
  })

  it('leaves an existing publish of the probed port untouched', () => {
    const doc = parse('services:\n  web:\n    image: nginx\n    ports:\n      - "8080"\n')
    ensureServicePublishes(doc, 'web', 8080)
    expect(doc.services.web.ports).toEqual(['8080'])
  })
})

describe('collectUnsupportedComposeRefs', () => {
  it('rejects build contexts, host bind mounts, relative env_files, and privileged', () => {
    const doc = parse(
      [
        'services:',
        '  web:',
        '    build: .',
        '    volumes:',
        '      - ./src:/app',
        '      - data:/var/lib/data', // named volume — allowed
        '    env_file:',
        '      - ./.env',
        '  sidecar:',
        '    image: busybox',
        '    privileged: true',
        'volumes:',
        '  data: {}',
      ].join('\n'),
    )
    const issues = collectUnsupportedComposeRefs(doc)
    expect(issues.some((i) => i.includes('build:'))).toBe(true)
    expect(issues.some((i) => i.includes('bind-mounts'))).toBe(true)
    expect(issues.some((i) => i.includes('env_file'))).toBe(true)
    expect(issues.some((i) => i.includes('privileged'))).toBe(true)
    // The named volume is NOT flagged.
    expect(issues.some((i) => i.includes('data:/var/lib/data'))).toBe(false)
  })

  it('passes a clean image-based stack', () => {
    const doc = parse('services:\n  web:\n    image: nginx\n    volumes:\n      - cache:/cache\n')
    expect(collectUnsupportedComposeRefs(doc)).toEqual([])
  })

  describe('build mode ({ build: true })', () => {
    it('allows build:, in-checkout relative binds, and relative env_files (the checkout resolves them)', () => {
      const doc = parse(
        [
          'services:',
          '  web:',
          '    build: .',
          '    volumes:',
          '      - ./src:/app', // in-checkout relative bind — allowed in build mode
          '      - db-data:/var/lib/data', // named volume — allowed
          '    env_file:',
          '      - ./.env', // relative env_file — allowed in build mode
          'volumes:',
          '  db-data: {}',
        ].join('\n'),
      )
      expect(collectUnsupportedComposeRefs(doc, { build: true })).toEqual([])
    })

    it('still refuses privileged and a host-escaping bind mount', () => {
      const doc = parse(
        [
          'services:',
          '  web:',
          '    build: .',
          '    volumes:',
          '      - /etc:/host-etc', // absolute host path — escapes the checkout
          '      - ../secrets:/s', // ../ escapes above the checkout root
          '  sidecar:',
          '    image: busybox',
          '    privileged: true',
        ].join('\n'),
      )
      const issues = collectUnsupportedComposeRefs(doc, { build: true })
      expect(issues.some((i) => i.includes('/host-etc') || i.includes("'/etc'"))).toBe(true)
      expect(issues.some((i) => i.includes('../secrets'))).toBe(true)
      expect(issues.some((i) => i.includes('privileged'))).toBe(true)
      // build: is NOT flagged in build mode.
      expect(issues.some((i) => i.includes('uses build:'))).toBe(false)
    })

    it('refuses a host-escaping env_file (not just bind mounts)', () => {
      const doc = parse(
        [
          'services:',
          '  web:',
          '    build: .',
          '    env_file:',
          '      - ../../../../etc/secret.env', // ../ escapes the checkout
          '      - /etc/host.env', // absolute host path
          '      - ./.env', // in-checkout relative — allowed
        ].join('\n'),
      )
      const issues = collectUnsupportedComposeRefs(doc, { build: true })
      expect(issues.some((i) => i.includes('../../../../etc/secret.env'))).toBe(true)
      expect(issues.some((i) => i.includes('/etc/host.env'))).toBe(true)
      // The in-checkout env_file is NOT flagged.
      expect(issues.some((i) => i.includes("'./.env'"))).toBe(false)
    })

    it('refuses a build context that escapes the checkout', () => {
      const doc = parse('services:\n  web:\n    build:\n      context: /\n')
      const issues = collectUnsupportedComposeRefs(doc, { build: true })
      expect(issues.some((i) => i.includes('context outside the checkout'))).toBe(true)
    })

    it('refuses a separator-buried ../ bind source (not mis-read as a named volume)', () => {
      const doc = parse(
        'services:\n  web:\n    build: .\n    volumes:\n      - sub/../../../etc:/host\n',
      )
      const issues = collectUnsupportedComposeRefs(doc, { build: true })
      expect(issues.some((i) => i.includes('sub/../../../etc'))).toBe(true)
    })

    it('refuses a bind source with an unresolved ${VAR} interpolation', () => {
      const doc = parse('services:\n  web:\n    build: .\n    volumes:\n      - ${HOME}/x:/x\n')
      const issues = collectUnsupportedComposeRefs(doc, { build: true })
      expect(issues.some((i) => i.includes('${HOME}/x'))).toBe(true)
    })

    it('refuses a host-escaping secret file: source', () => {
      const doc = parse(
        [
          'services:',
          '  web:',
          '    build: .',
          '    secrets:',
          '      - leak',
          'secrets:',
          '  leak:',
          '    file: /etc/host-secret',
        ].join('\n'),
      )
      const issues = collectUnsupportedComposeRefs(doc, { build: true })
      expect(issues.some((i) => i.includes('/etc/host-secret'))).toBe(true)
    })
  })

  it('refuses include: in both modes (merged files bypass the guard)', () => {
    const doc = parse('include:\n  - ./ci/base.yml\nservices:\n  web:\n    image: nginx\n')
    expect(collectUnsupportedComposeRefs(doc).some((i) => i.includes('include:'))).toBe(true)
    expect(
      collectUnsupportedComposeRefs(doc, { build: true }).some((i) => i.includes('include:')),
    ).toBe(true)
  })

  it('refuses cross-file extends.file (merged from disk, bypasses the guard)', () => {
    const doc = parse(
      'services:\n  web:\n    image: nginx\n    extends:\n      file: ./base.yml\n      service: base\n',
    )
    expect(
      collectUnsupportedComposeRefs(doc, { build: true }).some((i) => i.includes('extends.file')),
    ).toBe(true)
  })

  it('refuses a top-level config file: source in image mode (no repo on disk)', () => {
    const doc = parse(
      'services:\n  web:\n    image: nginx\n    configs:\n      - app\nconfigs:\n  app:\n    file: ./app.conf\n',
    )
    expect(collectUnsupportedComposeRefs(doc).some((i) => i.includes('app.conf'))).toBe(true)
  })
})

describe('hasBuildDirective', () => {
  it('detects a short- and long-form build, ignores an image-only service', () => {
    expect(hasBuildDirective({ build: '.' })).toBe(true)
    expect(hasBuildDirective({ build: { context: './app' } })).toBe(true)
    expect(hasBuildDirective({ image: 'nginx' })).toBe(false)
    expect(hasBuildDirective(null)).toBe(false)
    expect(hasBuildDirective('nope')).toBe(false)
  })
})

describe('escapesCheckout', () => {
  it('flags absolute, home, drive, and ../-escaping sources; allows in-checkout relatives', () => {
    expect(escapesCheckout('/etc')).toBe(true)
    expect(escapesCheckout('~/x')).toBe(true)
    expect(escapesCheckout('C:/x')).toBe(true)
    expect(escapesCheckout('../secrets')).toBe(true)
    expect(escapesCheckout('a/../../b')).toBe(true) // pops above root
    expect(escapesCheckout('\\\\server\\share')).toBe(true) // UNC / backslash-absolute
    expect(escapesCheckout('${HOME}/x')).toBe(true) // unresolved var expands at runtime
    expect(escapesCheckout('$PWD/../x')).toBe(true)
    expect(escapesCheckout('./src')).toBe(false)
    expect(escapesCheckout('src')).toBe(false)
    expect(escapesCheckout('a/b/c')).toBe(false)
    expect(escapesCheckout('a/../b')).toBe(false) // stays at/below root
  })
})

describe('composeFileDir', () => {
  it('returns the POSIX directory portion, empty for a root-level file', () => {
    expect(composeFileDir('docker-compose.yml')).toBe('')
    expect(composeFileDir('./docker-compose.yml')).toBe('')
    expect(composeFileDir('deploy/docker-compose.yml')).toBe('deploy')
    expect(composeFileDir('a/b/compose.yaml')).toBe('a/b')
    expect(composeFileDir('deploy\\compose.yaml')).toBe('deploy')
  })
})

describe('parseComposeEnvConfig — build mode', () => {
  it('coerces the build flag + buildTimeoutMinutes from their string forms', () => {
    const config = parseComposeEnvConfig(
      manifestWith({ service: 'web', port: '8080', build: 'true', buildTimeoutMinutes: '20' }),
    )
    expect(config.build).toBe(true)
    expect(config.buildTimeoutMs).toBe(20 * 60_000)
  })

  it('defaults build to false and leaves buildTimeoutMs undefined', () => {
    const config = parseComposeEnvConfig(manifestWith({ service: 'web', port: '8080' }))
    expect(config.build).toBe(false)
    expect(config.buildTimeoutMs).toBeUndefined()
  })
})

describe('prepareComposeProject', () => {
  it('rewrites a pinned host port to ephemeral and guarantees the probed port publishes', () => {
    const { content, issues } = prepareComposeProject(
      'services:\n  web:\n    image: nginx\n    ports:\n      - "8080:8080"\n',
      'web',
      8080,
    )
    expect(issues).toEqual([])
    expect(parse(content).services.web.ports).toEqual(['8080'])
  })

  it('flags a service that builds from source', () => {
    const { issues } = prepareComposeProject('services:\n  web:\n    build: .\n', 'web', 8080)
    expect(issues.some((i) => i.includes('build:'))).toBe(true)
  })

  it('flags a missing probed service', () => {
    const { issues } = prepareComposeProject('services:\n  api:\n    image: nginx\n', 'web', 8080)
    expect(issues.some((i) => i.includes("no service named 'web'"))).toBe(true)
  })

  it('flags invalid YAML rather than throwing', () => {
    const { issues } = prepareComposeProject(': : not yaml', 'web', 8080)
    expect(issues.length).toBeGreaterThan(0)
  })
})

describe('parseHostPort', () => {
  it('reads the host port from docker compose port output', () => {
    expect(parseHostPort('0.0.0.0:49153')).toBe(49153)
    expect(parseHostPort('[::]:49154\n')).toBe(49154)
    expect(parseHostPort('')).toBeNull()
    expect(parseHostPort('no-port-here')).toBeNull()
  })
})

describe('classifyComposePs', () => {
  it('is ready when every service runs and none are unhealthy', () => {
    const out = JSON.stringify([
      { State: 'running', Health: 'healthy' },
      { State: 'running', Health: '' },
    ])
    expect(classifyComposePs(out)).toBe('ready')
  })

  it('is provisioning while a service is starting', () => {
    expect(classifyComposePs(JSON.stringify([{ State: 'running', Health: 'starting' }]))).toBe(
      'provisioning',
    )
  })

  it('is failed when a service is unhealthy', () => {
    expect(classifyComposePs(JSON.stringify([{ State: 'running', Health: 'unhealthy' }]))).toBe(
      'failed',
    )
  })

  it('is failed when nothing is left (empty ps -a ⇒ project gone)', () => {
    expect(classifyComposePs('')).toBe('failed')
  })

  it('treats a clean one-shot (exited 0) as complete, not a failure', () => {
    const out = JSON.stringify([
      { State: 'running', Health: 'healthy' },
      { State: 'exited', ExitCode: 0 },
    ])
    expect(classifyComposePs(out)).toBe('ready')
  })

  it('is failed when a container exited non-zero (a real crash)', () => {
    expect(classifyComposePs(JSON.stringify([{ State: 'exited', ExitCode: 137 }]))).toBe('failed')
  })

  it('is provisioning while a container is recreating (does not flip a healthy env to failed)', () => {
    expect(classifyComposePs(JSON.stringify([{ State: 'restarting' }]))).toBe('provisioning')
  })

  it('parses newline-delimited JSON objects (older compose)', () => {
    const rows = parseComposePsRows('{"State":"running"}\n{"State":"running"}')
    expect(rows).toHaveLength(2)
  })
})

describe('renderEnvMap', () => {
  it('templates each value', () => {
    expect(renderEnvMap({ IMAGE: 'app:{{branch}}' }, { branch: 'main' })).toEqual({
      IMAGE: 'app:main',
    })
  })
})

describe('extractExternalNetworks', () => {
  it('resolves external networks from `external: true` and `external: { name }`, deduped', () => {
    const doc = parse(
      'networks:\n' +
        '  a:\n    external: true\n' +
        '  b:\n    external:\n      name: shared-bus\n' +
        '  c:\n    external: true\n    name: shared-bus\n', // dup of b's resolved name
    )
    expect(extractExternalNetworks(doc)).toEqual(['a', 'shared-bus'])
  })

  it('ignores project-owned networks (`external: false` or absent)', () => {
    const doc = parse('networks:\n  a:\n    external: false\n  b:\n    driver: bridge\n  c:\n')
    expect(extractExternalNetworks(doc)).toEqual([])
  })

  it('does NOT treat a malformed array `external:` value as an external network', () => {
    // `typeof [] === 'object'` — the guard must reject arrays, not fabricate a network named `a`.
    const doc = parse('networks:\n  a:\n    external: []\n')
    expect(extractExternalNetworks(doc)).toEqual([])
  })
})

describe('extractComposeProfiles', () => {
  it('unions + sorts every service profile label, handling a single-string profiles value', () => {
    const doc = parse(
      'services:\n' +
        '  app:\n    profiles: [full]\n' +
        '  peer:\n    profiles: [peer, backends]\n' +
        '  solo:\n    profiles: extra\n', // single string, not a list
    )
    expect(extractComposeProfiles(doc)).toEqual(['backends', 'extra', 'full', 'peer'])
  })
})

describe('parseComposeEnvConfig — recipe', () => {
  it('reads a persisted recipe off providerConfig (structural, not re-validated)', () => {
    const recipe = { composeFiles: ['docker/dev.yml'], composeProfiles: ['backends'] }
    const config = parseComposeEnvConfig(manifestWith({ service: 'web', port: '8080', recipe }))
    expect(config.recipe).toEqual(recipe)
  })
  it('treats a non-object recipe as absent', () => {
    const config = parseComposeEnvConfig(
      manifestWith({ service: 'web', port: '8080', recipe: 'nope' }),
    )
    expect(config.recipe).toBeUndefined()
  })
  it('reads the host-command opt-in from its string form', () => {
    expect(
      parseComposeEnvConfig(
        manifestWith({ service: 'web', port: '8080', allowHostCommands: 'true' }),
      ).allowHostCommands,
    ).toBe(true)
    expect(
      parseComposeEnvConfig(manifestWith({ service: 'web', port: '8080' })).allowHostCommands,
    ).toBe(false)
  })
})

describe('resolveRecipeComposeFiles', () => {
  it('uses recipe.composeFiles in order when present, else falls back to composePath', () => {
    expect(
      resolveRecipeComposeFiles(
        { composeFiles: ['docker/dev.yml', 'docker/dev.wsl.override.yml'] },
        'x.yml',
      ),
    ).toEqual(['docker/dev.yml', 'docker/dev.wsl.override.yml'])
    expect(resolveRecipeComposeFiles({}, 'docker-compose.yml')).toEqual(['docker-compose.yml'])
    expect(resolveRecipeComposeFiles({ composeFiles: [] }, 'docker-compose.yml')).toEqual([
      'docker-compose.yml',
    ])
  })
})

describe('rewrittenRecipeComposePath', () => {
  it('prefixes the basename in the file’s own dir so it never clobbers the original', () => {
    expect(rewrittenRecipeComposePath('docker/dev.yml')).toBe('docker/cat-factory.dev.yml')
    expect(rewrittenRecipeComposePath('docker/dev.wsl.override.yml')).toBe(
      'docker/cat-factory.dev.wsl.override.yml',
    )
    expect(rewrittenRecipeComposePath('docker-compose.yml')).toBe('cat-factory.docker-compose.yml')
  })
})

describe('prepareRecipeComposeFiles', () => {
  it('neutralizes host ports across layers + guarantees the probed service publishes', () => {
    const prepared = prepareRecipeComposeFiles(
      [
        {
          path: 'docker/dev.yml',
          text: 'services:\n  web:\n    image: nginx\n    ports:\n      - "8080:8080"\n  db:\n    image: postgres\n    ports:\n      - "5432:5432"\n',
        },
        {
          path: 'docker/dev.override.yml',
          text: 'services:\n  web:\n    environment:\n      - FOO=bar\n',
        },
      ],
      'web',
      8080,
      { baseDepth: 1 },
    )
    expect(prepared.issues).toEqual([])
    expect(prepared.files.map((f) => f.path)).toEqual([
      'docker/cat-factory.dev.yml',
      'docker/cat-factory.dev.override.yml',
    ])
    const base = parse(prepared.files[0]!.content)
    // Host ports stripped to ephemeral on every service; the probed service still publishes 8080.
    expect(base.services.web.ports).toEqual(['8080'])
    expect(base.services.db.ports).toEqual(['5432'])
  })

  it('flags a stack where no layer defines the probed service', () => {
    const prepared = prepareRecipeComposeFiles(
      [{ path: 'docker-compose.yml', text: 'services:\n  api:\n    image: nginx\n' }],
      'web',
      8080,
      { baseDepth: 0 },
    )
    expect(prepared.issues.some((i) => i.includes("no service named 'web'"))).toBe(true)
  })

  it('refuses a checkout-escaping bind mount (host-filesystem escape), prefixed by file', () => {
    const prepared = prepareRecipeComposeFiles(
      [
        {
          path: 'docker/dev.yml',
          text: 'services:\n  web:\n    image: nginx\n    volumes:\n      - ../../etc:/host\n',
        },
      ],
      'web',
      8080,
      { baseDepth: 1 },
    )
    expect(
      prepared.issues.some((i) => i.startsWith('docker/dev.yml:') && i.includes('escape')),
    ).toBe(true)
  })
})

describe('recipeCheckoutPathIssues', () => {
  it('flags every checkout-escaping recipe path but allows in-checkout relatives', () => {
    const recipe: StackRecipe = {
      envFiles: [
        { template: '.env.dev.local-dist', target: '.env.dev.local' }, // ok
        { template: '/etc/passwd', target: '.env' }, // escape (absolute)
      ],
      setupSteps: [
        { kind: 'copy-file', name: 'ok copy', from: 'a/.split.dist', to: 'a/.split.yaml' },
        {
          kind: 'compose-exec',
          name: 'seed',
          service: 'db',
          command: ['sh'],
          stdinFile: '../../secret.sql',
        },
        { kind: 'host-command', name: 'host', command: ['echo'], workdir: 'sub' },
        { kind: 'wait-file', name: 'wait ct', path: '/app/manifest.json', service: 'web' }, // container-absolute: skipped
      ],
    }
    const issues = recipeCheckoutPathIssues(recipe)
    expect(issues.some((i) => i.includes('/etc/passwd'))).toBe(true)
    expect(issues.some((i) => i.includes('secret.sql'))).toBe(true)
    // The in-checkout relatives + the container-target wait-file raise nothing.
    expect(issues.some((i) => i.includes('.env.dev.local-dist'))).toBe(false)
    expect(issues.some((i) => i.includes('manifest.json'))).toBe(false)
  })
  it('flags a checkout-escaping composeFiles layer (written back + feeds --project-directory)', () => {
    const issues = recipeCheckoutPathIssues({
      composeFiles: ['docker/dev.yml', '../../evil/dev.yml'],
    })
    expect(issues.some((i) => i.includes('../../evil/dev.yml'))).toBe(true)
    expect(issues.some((i) => i.includes('docker/dev.yml'))).toBe(false)
  })
  it('ignores teardownStep paths (teardown execution is deferred)', () => {
    const issues = recipeCheckoutPathIssues({
      teardownSteps: [{ kind: 'copy-file', name: 'td', from: '/etc/passwd', to: '.env' }],
    })
    expect(issues).toEqual([])
  })
})

describe('recipeProfilesEnv', () => {
  it('comma-joins profiles into COMPOSE_PROFILES, or {} when none', () => {
    expect(recipeProfilesEnv({ composeProfiles: ['backends', 'peer'] })).toEqual({
      COMPOSE_PROFILES: 'backends,peer',
    })
    expect(recipeProfilesEnv({})).toEqual({})
  })
})

describe('recipeStepTimeoutMs', () => {
  it('prefers the step’s own timeout, else a per-kind default', () => {
    expect(
      recipeStepTimeoutMs({
        kind: 'compose-exec',
        name: 's',
        service: 'a',
        command: ['x'],
        timeoutMs: 1000,
      }),
    ).toBe(1000)
    expect(
      recipeStepTimeoutMs({ kind: 'compose-exec', name: 's', service: 'a', command: ['x'] }),
    ).toBe(DEFAULT_RECIPE_STEP_TIMEOUT_MS)
    expect(recipeStepTimeoutMs({ kind: 'wait-http', name: 'w', url: 'http://x' })).toBe(
      DEFAULT_RECIPE_WAIT_TIMEOUT_MS,
    )
    // An explicit `0` is honored, not treated as unset (`??`, not truthiness).
    expect(
      recipeStepTimeoutMs({
        kind: 'compose-exec',
        name: 's',
        service: 'a',
        command: ['x'],
        timeoutMs: 0,
      }),
    ).toBe(0)
  })
})

describe('composeExecArgs / waitFileExecArgs', () => {
  it('builds a non-interactive exec with optional user + workdir', () => {
    expect(
      composeExecArgs(['-p', 'proj'], {
        service: 'app',
        command: ['bin/console', 'migrate'],
        user: 'www',
        workdir: '/app',
      }),
    ).toEqual([
      '-p',
      'proj',
      'exec',
      '-T',
      '--user',
      'www',
      '--workdir',
      '/app',
      'app',
      'bin/console',
      'migrate',
    ])
    expect(composeExecArgs(['-p', 'proj'], { service: 'app', command: ['ls'] })).toEqual([
      '-p',
      'proj',
      'exec',
      '-T',
      'app',
      'ls',
    ])
  })
  it('builds a `test -f` probe for a container wait-file', () => {
    expect(waitFileExecArgs(['-p', 'proj'], 'ui', '/app/manifest.json')).toEqual([
      '-p',
      'proj',
      'exec',
      '-T',
      'ui',
      'test',
      '-f',
      '/app/manifest.json',
    ])
  })
})

describe('matchesHttpExpectation', () => {
  it('accepts any 2xx by default, an exact expected status, and a required body substring', () => {
    expect(matchesHttpExpectation(200, '', {})).toBe(true)
    expect(matchesHttpExpectation(500, '', {})).toBe(false)
    expect(matchesHttpExpectation(204, '', { expectStatus: 204 })).toBe(true)
    expect(matchesHttpExpectation(200, '', { expectStatus: 204 })).toBe(false)
    expect(matchesHttpExpectation(200, 'all good', { expectBodyContains: 'good' })).toBe(true)
    expect(matchesHttpExpectation(200, 'nope', { expectBodyContains: 'good' })).toBe(false)
  })
})
