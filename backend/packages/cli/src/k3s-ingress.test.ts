import { describe, expect, it } from 'vitest'
import { COMMAND_NOT_FOUND, type HostShell, type ShellResult } from './host-shell.js'
import {
  classifyIngress,
  DEFAULT_INGRESS_PORT,
  ingressHostTemplate,
  ingressRemedies,
  listIngressClassesCommand,
  parseIngressClasses,
  type PortState,
  probeIngress,
  type TcpProbe,
} from './k3s-ingress.js'

function fakeTcp(state: PortState): TcpProbe {
  return { probe: () => Promise.resolve(state) }
}

function scriptShell(results: Partial<ShellResult>[]): HostShell & { calls: number } {
  const queue = [...results]
  const shell = {
    calls: 0,
    run(): Promise<ShellResult> {
      shell.calls++
      const hit = queue.length > 1 ? queue.shift() : queue[0]
      return Promise.resolve({
        code: hit?.code ?? COMMAND_NOT_FOUND,
        stdout: hit?.stdout ?? '',
        stderr: hit?.stderr ?? '',
      })
    },
  }
  return shell
}

const TRAEFIK = JSON.stringify({
  items: [{ metadata: { name: 'traefik' }, spec: { controller: 'traefik.io/ingress-controller' } }],
})

describe('parseIngressClasses', () => {
  it('reads the controller, falling back to the class name', () => {
    expect(parseIngressClasses(TRAEFIK)).toEqual(['traefik.io/ingress-controller'])
    expect(
      parseIngressClasses(JSON.stringify({ items: [{ metadata: { name: 'nginx' } }] })),
    ).toEqual(['nginx'])
  })

  it('distinguishes an EMPTY list from an unreadable one', () => {
    // The distinction the whole three-state verdict rests on: `[]` is a definitive "no ingress
    // controller"; `null` is "this probe learned nothing".
    expect(parseIngressClasses(JSON.stringify({ items: [] }))).toEqual([])
    expect(parseIngressClasses('error: connection refused')).toBeNull()
    expect(parseIngressClasses('{}')).toBeNull()
  })
})

describe('classifyIngress', () => {
  const port = DEFAULT_INGRESS_PORT

  it('is READY only when a controller answered and the host port is open', () => {
    expect(classifyIngress({ port, controllers: ['traefik'], hostPort: 'open' })).toEqual({
      status: 'ready',
      port,
      controller: 'traefik',
    })
  })

  it('names each missing half separately, because each has its own fix', () => {
    expect(classifyIngress({ port, controllers: [], hostPort: 'open' })).toMatchObject({
      status: 'missing',
      gaps: ['controller'],
    })
    expect(classifyIngress({ port, controllers: ['traefik'], hostPort: 'closed' })).toMatchObject({
      status: 'missing',
      gaps: ['hostPort'],
    })
    expect(classifyIngress({ port, controllers: [], hostPort: 'closed' })).toMatchObject({
      status: 'missing',
      gaps: ['controller', 'hostPort'],
    })
  })

  it('is UNKNOWN when the cluster could not be read, whatever the port did', () => {
    expect(classifyIngress({ port, controllers: null, hostPort: 'open' }).status).toBe('unknown')
    expect(classifyIngress({ port, controllers: null, hostPort: 'closed' }).status).toBe('unknown')
  })

  it('keeps an undecidable PORT out of the missing verdict, but not an absent controller', () => {
    // A filtered port is undecided; a cluster with no controller cannot serve the URL either way,
    // so that half stays a definitive `missing` rather than being softened to `unknown`.
    expect(classifyIngress({ port, controllers: ['traefik'], hostPort: 'unknown' }).status).toBe(
      'unknown',
    )
    expect(classifyIngress({ port, controllers: [], hostPort: 'unknown' })).toMatchObject({
      status: 'missing',
      gaps: ['controller'],
    })
  })
})

describe('ingressHostTemplate', () => {
  it('withholds a template unless the ingress was established', () => {
    expect(ingressHostTemplate({ status: 'ready', port: 80, controller: 'traefik' })).toBe(
      '{{branch}}.127.0.0.1.nip.io',
    )
    expect(ingressHostTemplate({ status: 'missing', port: 80, gaps: ['controller'] })).toBeNull()
    expect(ingressHostTemplate({ status: 'unknown', port: 80, probeFailure: 'x' })).toBeNull()
  })

  it('puts a non-default port IN the host, the only place the derivation reads one', () => {
    expect(ingressHostTemplate({ status: 'ready', port: 8080, controller: 'traefik' })).toBe(
      '{{branch}}.127.0.0.1.nip.io:8080',
    )
  })
})

describe('ingressRemedies', () => {
  it('points a missing host port at --recreate, carrying the run’s own flags', () => {
    const lines = ingressRemedies(
      { status: 'missing', port: 8080, gaps: ['hostPort'] },
      { runtime: 'k3d', clusterName: 'mine' },
    ).join('\n')
    // A published host port cannot be added to a running cluster, so a `docker` incantation here
    // would be advice that cannot work.
    expect(lines).toContain('cat-factory k3s --recreate --runtime k3d --cluster-name mine')
    expect(lines).toContain('--ingress-port 8080')
  })

  it('gives kind its own controller remedy, since kind ships none', () => {
    const kind = ingressRemedies(
      { status: 'missing', port: 80, gaps: ['controller'] },
      { runtime: 'kind' },
    ).join('\n')
    expect(kind).toContain('kind ships no ingress controller')
    const k3d = ingressRemedies(
      { status: 'missing', port: 80, gaps: ['controller'] },
      { runtime: 'k3d' },
    ).join('\n')
    // A k3d/k3s cluster with no Traefik was almost certainly created with --disable=traefik.
    expect(k3d).toContain('--disable=traefik')
  })

  it('offers nothing for a verified ingress and only re-probing for an undecided one', () => {
    expect(ingressRemedies({ status: 'ready', port: 80, controller: 'traefik' })).toEqual([])
    expect(
      ingressRemedies({ status: 'unknown', port: 80, probeFailure: 'x' }).join('\n'),
    ).toContain('once the cluster has settled')
  })
})

describe('probeIngress', () => {
  it('reads the IngressClasses and the host port together', async () => {
    const shell = scriptShell([{ code: 0, stdout: TRAEFIK }])
    const readiness = await probeIngress({ shell, tcp: fakeTcp('open') }, { port: 80 })
    expect(readiness).toEqual({
      status: 'ready',
      port: 80,
      controller: 'traefik.io/ingress-controller',
    })
    expect(shell.calls).toBe(1)
  })

  it('WAITS for a freshly created cluster to install its bundled controller', async () => {
    // Verified against k3d 5.7.5: `k3d cluster create` returns ~20-30s before the Traefik
    // HelmChart Job completes, so a single immediate read reports a definitive `missing` for a
    // cluster that is merely still starting — the same class of lie this module removes.
    const shell = scriptShell([
      { code: 0, stdout: JSON.stringify({ items: [] }) },
      { code: 0, stdout: JSON.stringify({ items: [] }) },
      { code: 0, stdout: TRAEFIK },
    ])
    const readiness = await probeIngress(
      { shell, tcp: fakeTcp('open'), sleep: () => Promise.resolve() },
      { port: 80, waitMs: 10_000 },
    )
    expect(readiness.status).toBe('ready')
    expect(shell.calls).toBe(3)
  })

  it('reports the LAST verdict when the wait runs out, rather than pretending', async () => {
    const shell = scriptShell([{ code: 0, stdout: JSON.stringify({ items: [] }) }])
    const readiness = await probeIngress(
      { shell, tcp: fakeTcp('closed'), sleep: () => Promise.resolve() },
      { port: 80, waitMs: 4_000 },
    )
    expect(readiness).toMatchObject({ status: 'missing', gaps: ['controller', 'hostPort'] })
  })

  it('does not wait at all on the reuse path (waitMs defaults to 0)', async () => {
    const shell = scriptShell([{ code: 0, stdout: JSON.stringify({ items: [] }) }])
    await probeIngress({ shell, tcp: fakeTcp('closed') }, { port: 80 })
    expect(shell.calls).toBe(1)
  })
})

describe('listIngressClassesCommand', () => {
  it('targets a specific context when one is supplied, and carries a request timeout', () => {
    expect(listIngressClassesCommand().args).toEqual([
      'get',
      'ingressclass',
      '-o',
      'json',
      '--request-timeout=5s',
    ])
    expect(listIngressClassesCommand('k3d-x').args.slice(-2)).toEqual(['--context', 'k3d-x'])
  })
})
