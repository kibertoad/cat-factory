import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  classifyComposePs,
  collectUnsupportedComposeRefs,
  composeConfigToManifest,
  composeFileDir,
  ensureServicePublishes,
  escapesCheckout,
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
} from './compose-environment.logic.js'

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
