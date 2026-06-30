import { describe, expect, it } from 'vitest'
import {
  buildPublishOverride,
  classifyComposePs,
  composeConfigToManifest,
  parseComposeEnvConfig,
  parseComposePsRows,
  parseHostPort,
  renderEnvMap,
  resolveProjectName,
  sanitizeProjectName,
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
})

describe('buildPublishOverride', () => {
  it('publishes the service container port to an ephemeral host port', () => {
    const yaml = buildPublishOverride('web', 8080)
    expect(yaml).toContain('web:')
    expect(yaml).toContain('"8080"')
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

  it('is failed when nothing is running', () => {
    expect(classifyComposePs('')).toBe('failed')
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
