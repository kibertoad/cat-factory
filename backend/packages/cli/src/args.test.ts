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

  it('parses --ingress-port and --recreate', () => {
    const o = parseArgs(['k3s', '--ingress-port', '8080', '--recreate'])
    expect(o.ingressPort).toBe(8080)
    expect(o.recreate).toBe(true)
    // Absent means "use the default", never 0: the port is only ever set deliberately.
    expect(parseArgs(['k3s']).ingressPort).toBeUndefined()
    expect(parseArgs(['k3s']).recreate).toBeUndefined()
  })

  it('rejects an --ingress-port that is not a port, naming the flag it rejected', () => {
    expect(() => parseArgs(['k3s', '--ingress-port', '0'])).toThrow(/--ingress-port/)
    expect(() => parseArgs(['k3s', '--ingress-port', '70000'])).toThrow(ArgError)
  })

  it('rejects a malformed --app-url up front (before any provisioning)', () => {
    // A missing scheme is an easy mistake and would otherwise throw from `new URL(...)` at the very
    // end of a successful run — reject it at parse time instead.
    expect(() => parseArgs(['k3s', '--app-url', 'localhost'])).toThrow(ArgError)
    expect(() => parseArgs(['k3s', '--app-url', 'localhost:3000'])).toThrow(ArgError)
    expect(() => parseArgs(['k3s', '--app-url', 'ftp://example.com'])).toThrow(ArgError)
  })
})

describe('parseArgs — supervise', () => {
  it('parses the supervise flags and the passthrough command', () => {
    const o = parseArgs([
      'supervise',
      '--port',
      '8788',
      '--health-path=/ready',
      '--compose-service',
      'postgres',
      '--compose-dir',
      './deploy/local',
      '--k3s-cluster',
      'cat-factory',
      '--poll',
      '5',
      '--boot-grace=30',
      '--failures',
      '2',
      '--',
      'pnpm',
      'dev',
    ])
    expect(o.command).toBe('supervise')
    expect(o.port).toBe(8788)
    expect(o.healthPath).toBe('/ready')
    expect(o.composeService).toBe('postgres')
    expect(o.composeDir).toBe('./deploy/local')
    expect(o.k3sCluster).toBe('cat-factory')
    expect(o.pollSeconds).toBe(5)
    expect(o.bootGraceSeconds).toBe(30)
    expect(o.failures).toBe(2)
    expect(o.superviseCommand).toEqual(['pnpm', 'dev'])
  })

  it('hands the child its OWN flags untouched, instead of trying to parse them', () => {
    // The whole point of `--`: `--watch` and `-y` belong to the child, and an unknown-argument
    // error here would make the supervisor unable to wrap the very commands it exists to wrap.
    const o = parseArgs(['supervise', '--', 'node', '--watch', 'src/main.ts', '-y'])
    expect(o.superviseCommand).toEqual(['node', '--watch', 'src/main.ts', '-y'])
  })

  it('leaves superviseCommand unset when no `--` was given', () => {
    expect(parseArgs(['supervise']).superviseCommand).toBeUndefined()
  })

  it('rejects a health path that is not rooted', () => {
    expect(() => parseArgs(['supervise', '--health-path', 'health'])).toThrow(ArgError)
  })

  it('rejects non-positive timings and a zero failure threshold', () => {
    expect(() => parseArgs(['supervise', '--poll', '0'])).toThrow(ArgError)
    expect(() => parseArgs(['supervise', '--boot-grace', '-1'])).toThrow(ArgError)
    expect(() => parseArgs(['supervise', '--failures', '0'])).toThrow(ArgError)
  })

  it('rejects a fractional poll interval', () => {
    // A 1ms poll spins a core, and since the clock-jump threshold derives from the interval it also
    // makes the probe's own latency read as a host suspend — which bypasses --failures entirely.
    expect(() => parseArgs(['supervise', '--poll', '0.001'])).toThrow(ArgError)
    expect(() => parseArgs(['supervise', '--poll', '1.5'])).toThrow(ArgError)
  })

  it('allows a zero boot grace, which is a real choice for a fast-booting command', () => {
    expect(parseArgs(['supervise', '--boot-grace', '0']).bootGraceSeconds).toBe(0)
  })

  it('refuses a supervise-only flag on another command instead of ignoring it', () => {
    // These share one option table, so nothing structural stops them being parsed for `init` and
    // then read by no code path at all. A silently-ignored flag is a typo the user wants to hear.
    expect(() => parseArgs(['init', '--failures', '2'])).toThrow(/only valid for/)
    expect(() => parseArgs(['env', '--health-path', '/ready'])).toThrow(ArgError)
    expect(() => parseArgs(['k3s', '--compose-service', 'postgres'])).toThrow(ArgError)
    expect(() => parseArgs(['init', '--', 'pnpm', 'dev'])).toThrow(ArgError)
  })

  it('still allows the flags it genuinely shares with other commands', () => {
    expect(parseArgs(['supervise', '--port', '8788', '--', 'x']).port).toBe(8788)
    expect(parseArgs(['k3s', '--runtime', 'kind']).k3sRuntime).toBe('kind')
  })
})
