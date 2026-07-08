import { describe, expect, it } from 'vitest'
import { ArgError, parseArgs } from './args.js'

describe('parseArgs', () => {
  it('defaults to the init command with sensible flags', () => {
    const opts = parseArgs([])
    expect(opts.command).toBe('init')
    expect(opts.yes).toBe(false)
    expect(opts.noOpen).toBe(false)
    expect(opts.force).toBe(false)
  })

  it('parses long flags with both space and = forms', () => {
    const opts = parseArgs(['--provider', 'gitlab', '--port=9000', '--token=glpat-x'])
    expect(opts.provider).toBe('gitlab')
    expect(opts.port).toBe(9000)
    expect(opts.token).toBe('glpat-x')
  })

  it('parses the boolean and command flags', () => {
    const opts = parseArgs(['init', '--yes', '--no-open', '--force', '--dir', 'out'])
    expect(opts.yes).toBe(true)
    expect(opts.noOpen).toBe(true)
    expect(opts.force).toBe(true)
    expect(opts.dir).toBe('out')
  })

  it('parses the env command and its reused flags', () => {
    const o = parseArgs(['env', '--dir', 'deploy/local', '--provider=gitlab', '--yes', '--force'])
    expect(o.command).toBe('env')
    expect(o.dir).toBe('deploy/local')
    expect(o.provider).toBe('gitlab')
    expect(o.yes).toBe(true)
    expect(o.force).toBe(true)
  })

  it('recognizes help and version', () => {
    expect(parseArgs(['--help']).command).toBe('help')
    expect(parseArgs(['-v']).command).toBe('version')
  })

  it('rejects an invalid provider', () => {
    expect(() => parseArgs(['--provider', 'bitbucket'])).toThrow(ArgError)
  })

  it('rejects an invalid port', () => {
    expect(() => parseArgs(['--port', '0'])).toThrow(ArgError)
    expect(() => parseArgs(['--port', 'abc'])).toThrow(ArgError)
  })

  it('parses and validates --container-runtime', () => {
    expect(parseArgs(['--container-runtime', 'podman']).containerRuntime).toBe('podman')
    expect(parseArgs(['--container-runtime=apple']).containerRuntime).toBe('apple')
    expect(() => parseArgs(['--container-runtime', 'lxc'])).toThrow(ArgError)
  })

  it('parses and validates --execution-mode', () => {
    expect(parseArgs(['--execution-mode', 'native']).executionMode).toBe('native')
    expect(parseArgs(['--execution-mode=pool']).executionMode).toBe('pool')
    expect(() => parseArgs(['--execution-mode', 'vm'])).toThrow(ArgError)
  })

  it('parses --native-harnesses (comma list, claude alias) and rejects unknowns', () => {
    expect(parseArgs(['--native-harnesses', 'claude-code,codex']).nativeHarnesses).toEqual([
      'claude-code',
      'codex',
    ])
    // `claude` is an alias for `claude-code`, deduped.
    expect(parseArgs(['--native-harnesses=claude,claude-code']).nativeHarnesses).toEqual([
      'claude-code',
    ])
    expect(() => parseArgs(['--native-harnesses', 'gemini'])).toThrow(ArgError)
    expect(() => parseArgs(['--native-harnesses', ''])).toThrow(ArgError)
  })

  it('parses --harness-entry verbatim', () => {
    expect(parseArgs(['--harness-entry', '/opt/harness/server.js']).harnessEntry).toBe(
      '/opt/harness/server.js',
    )
  })

  it('rejects an unknown flag and a missing value', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(ArgError)
    expect(() => parseArgs(['--dir'])).toThrow(/Missing value/)
  })

  it('parses the k3s command and its flags', () => {
    const o = parseArgs([
      'k3s',
      '--cluster-name',
      'dev',
      '--runtime=kind',
      '--app-url=http://localhost:4000',
      '--yes',
    ])
    expect(o.command).toBe('k3s')
    expect(o.clusterName).toBe('dev')
    expect(o.k3sRuntime).toBe('kind')
    expect(o.appUrl).toBe('http://localhost:4000')
    expect(o.yes).toBe(true)
  })

  it('rejects an invalid --runtime', () => {
    expect(() => parseArgs(['k3s', '--runtime', 'minikube'])).toThrow(ArgError)
  })

  it('rejects a malformed --app-url up front (before any provisioning)', () => {
    // A missing scheme is an easy mistake and would otherwise throw from `new URL(...)` at the very
    // end of a successful run — reject it at parse time instead.
    expect(() => parseArgs(['k3s', '--app-url', 'localhost'])).toThrow(ArgError)
    expect(() => parseArgs(['k3s', '--app-url', 'localhost:3000'])).toThrow(ArgError)
    expect(() => parseArgs(['k3s', '--app-url', 'ftp://example.com'])).toThrow(ArgError)
  })
})
