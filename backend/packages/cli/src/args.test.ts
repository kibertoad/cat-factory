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

  it('rejects an unknown flag and a missing value', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(ArgError)
    expect(() => parseArgs(['--dir'])).toThrow(/Missing value/)
  })

  it('parses the k3s command and its flags', () => {
    const o = parseArgs(['k3s', '--cluster-name', 'dev', '--runtime=kind', '--yes'])
    expect(o.command).toBe('k3s')
    expect(o.clusterName).toBe('dev')
    expect(o.k3sRuntime).toBe('kind')
    expect(o.yes).toBe(true)
  })

  it('rejects an invalid --runtime', () => {
    expect(() => parseArgs(['k3s', '--runtime', 'minikube'])).toThrow(ArgError)
  })
})
